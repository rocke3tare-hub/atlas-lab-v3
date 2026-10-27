# Atlas v3 — Architecture

## Layers

```
public/               Single-page UI: vanilla ES modules, html`` escapes everything, strict CSP, no build step
src/domain/           Pure logic, no I/O: calculator (simplex), mix (accumulators), rules (eligibility, turnover), profit
src/services/         Use cases: validation, role and client scope, journal posting, audit
src/db/               SQLite adapter (the only engine-specific code), migrations, idempotent seed
src/http/             Node http server, route table, security headers, CSRF and body-size checks
test/                 Domain unit tests and API integration tests over a real in-memory database
```

Every request that changes data runs in **one database transaction**. If any check fails, every write from that request is rolled back.

## Core concepts kept from v2

1. **Ownership chain:** client → shareholder profile → holders → money accounts and platform accounts. Money only moves inside one client, and funding or withdrawals only move between the same holder's accounts.
2. **Capital allocation:** the sum of holder allocations can never exceed client capital.
3. **Platform rule engine:** odds window, stake and payout caps, outcomes per event, shared outcomes, manual approval, and turnover requirements.
4. **Stake planner** for 1X2 and two-way markets, including draw-no-bet.
5. **Sequential accumulators** with the one-time free-bet deduction, hedges, and timing-gap checks.
6. **Withdrawal tracking** with delay reasons and arrival confirmation.
7. **Shareholder profit distribution:** attributed by capital ratio, then each shareholder's percentage is applied.
8. **Role-scoped visibility** (owner, admin, shareholder) and an audit trail.

## What was wrong in v2, and what v3 does instead

| v2 | v3 |
| --- | --- |
| Everything lived in browser `localStorage`. Passwords were stored in plain text in the source and the role was stored in an editable session object. | Server sessions in HttpOnly cookies, scrypt password hashes, login rate limits, and server-side role and client scope on every call. |
| A **Void** accumulator leg stayed "active" forever and its odds stayed in the combined price (reproduced: 6.0 instead of 3.0). | Void legs are skipped and priced at 1. |
| Each stake reservation was checked against the full balance on its own, so several reservations could overspend one account. | Available balance = balance − open reservations − pending withdrawals. |
| Profit shares divided a shareholder's base investment by a total that included approved top-ups, so the shares never summed to 100%. | The same capital figure is used on both sides of the ratio, with exact integer rounding. |
| Platform available balance added "remaining inside platform" from results on top of the cash balance (double counting). | A single journal-derived balance per account. |
| One wallet and one bank per holder in total, which made rial-to-dollar exchanges awkward. | One wallet and one bank per holder per currency. |
| The equal-profit planner used a heuristic hill-climb that could stop short of the best result. | An exact max-min linear programme (simplex), with rounding that protects the guarantee. |
| Floating-point money everywhere. | Integer minor units per currency; decimals beyond the currency's precision are rejected, not rounded. |
| The local server crashed on a malformed URL and could serve `.env` or `.git`. | Path checks, no dotfiles, an allow-listed set of file types, and a 400 response for malformed URLs. |
| Spreadsheet export did not protect against formula injection. | Text starting with `=`, `+`, `-` or `@` is neutralised. |

## Money model

`movements` is the journal. Each row has an optional source account (`from`), an optional destination account (`to`), the amount leaving (`amount_out`, in the source currency), the amount arriving (`amount_in`, in the destination currency), and a `fee` paid by the source.

- **A NULL side means "outside the books".** Examples: a payout arriving from a platform, or a cost being paid.
- **Account balance** = Σ amount_in − Σ (amount_out + fee).
- **Profit & loss** per currency = money crossing the boundary for trading reasons (payouts, stakes, income, costs, adjustments) minus all fees.
  - Capital injections, internal transfers, exchanges and shareholder payments are not profit.
  - A reversal counts as the kind of movement it reverses.

Database triggers make `movements`, `bonus_credits` and `audit_events` append-only.

## Simplifications to know about

- **Bonus and free-bet balances are tracked per platform account as pockets.** Credits minus stakes. Winnings from bonus or free bets are paid to the cash balance.
- **Shareholder distribution uses `BASE_CURRENCY` only.** Profit in other currencies is reported separately.
- **No PDF export.** Use the browser's print-to-PDF on any page, or the Excel export.
- **The v2 appearance and theme designer and the "Lab" feature-flag sandbox were not rebuilt.** They were presentation and experimentation layers, not business logic.
