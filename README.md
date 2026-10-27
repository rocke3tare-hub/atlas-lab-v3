# Atlas v3

A rebuild of `atlas-lab-v2`: client capital, account holders, wallets, banks and
platform accounts, versioned platform rules, stake planning, multi-leg
accumulators, withdrawals, and shareholder profit distribution. The business
rules now run on a server, not in browser `localStorage`.

- **No npm dependencies.** It runs on Node.js only and uses Node's built-in SQLite.
- **Money is stored as integer minor units in each currency.** Cents for USD, whole rials for IRR. Odds are stored in thousandths and percentages in basis points.
- **Balances are never stored.** They are derived from an append-only journal of money movements. Corrections post reversals; history is never edited.
- **The server enforces roles on every request:**
  - **owner:** everything;
  - **admin:** operates the clients assigned to them;
  - **shareholder:** reads only their own client.

## Quick local demo (Windows Command Prompt or PowerShell)

Requires **Node.js 22.13 or newer** (24 LTS recommended).

```bat
git clone https://github.com/rocke3tare-hub/atlas-lab-v3.git
cd atlas-lab-v3
copy .env.example .env
npm run db:seed -- --demo
npm start
```

Open <http://localhost:4190/>. All demo accounts use the `SEED_DEMO_PASSWORD` from `.env`:

| Email | Role |
| --- | --- |
| owner@atlas.local | Owner |
| admin@atlas.local | Admin (assigned to Northstar Capital) |
| nst@atlas.local | Shareholder of Northstar Capital |
| hbr@atlas.local | Shareholder of Harbor Partners |

The demo data is fictional: two clients, three holders, two platforms with different rules, and opening balances.

## What it does

| Area | Details |
| --- | --- |
| Clients & accounts | Client → holders → one wallet and one bank per currency → platform accounts. Holder allocations can never exceed the client's capital, which is the investment plus approved top-ups. |
| Money movements | Opening balances, capital, transfers with fees, currency exchanges with amounts on both sides, income, costs and owner adjustments. Overdrafts are refused. |
| Platforms | Each rule version sets minimum and maximum odds, maximum stake and payout, turnover percentage and base, outcomes allowed per event, shared outcomes, and owner approval. Bets keep the rule version they were checked against. |
| Operations | Events (two-way or 1X2) with a stake planner, then: an eligibility check per account, reserving a stake (which holds the balance), placing it (the stake leaves the account), and entering the result (payouts post automatically). Turnover progress is derived from settled stakes. |
| Stake planner | Maximises the **worst-case** result using an exact linear-programming (simplex) solver. It respects total capital, locked stakes and per-outcome minimums and maximums, and supports draw-no-bet and double-chance. Modes: balanced, target return, manual. |
| Accumulators | Legs settle in order. The free-bet deduction is applied once; hedges between legs are tracked; a hedge size can be suggested without placing anything; timing gaps between legs are checked. |
| Withdrawals | Requested → delayed / verification / problem → received or cancelled. The amount is held on the platform until it arrives; a shortfall on arrival is booked as a fee. A follow-up task opens and closes automatically. |
| Shareholders | Profit is attributed by capital share, then each shareholder's percentage is applied. Rounding is exact, so the parts always add up. Payments move money only when the owner marks them paid. Shareholders can request capital top-ups. |
| Tasks & questions | Automatic follow-ups, manual tasks, and conversations between shareholders and the team. |
| Reports | Dashboard, profit & loss per currency, Excel/CSV export and an append-only audit log. |

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the server; migrations run automatically |
| `npm test` | 29 tests: money rules, solver, accumulators, profit split, API flows, security |
| `npm run check` | Syntax-check every JavaScript file |
| `npm run db:seed [-- --demo]` | Create the owner account (and the demo data) |

## Important

- This tool records and plans. It does not connect to any betting platform, bank or wallet.
- Operating several people's betting accounts usually breaks the platforms' terms, and gambling is restricted or illegal in many places, including Iran. You are responsible for using it lawfully.
- v1's "rotation planner", which suggested cooling identities down to avoid repeated-use detection, was deliberately **not** carried over. Account readiness (verification, turnover, withdrawable balance) was kept.
- Before any real use: set a strong `PASSWORD_PEPPER`, `APP_ENV=production` and HTTPS (`SECURE_COOKIES=true`). Back up `data\atlas.sqlite` regularly.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and what was fixed from v2.
