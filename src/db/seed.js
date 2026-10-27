import { newId } from './database.js';
import { hashPassword } from '../services/auth.js';

/**
 * Idempotent seed. Always ensures the owner account. With demo=true also adds
 * a fictional client structure with balances so every screen has data.
 */
export function seed(db, config, { ownerEmail, ownerPassword, demo = false, demoPassword = null } = {}) {
  return db.tx(() => {
    const created = [];
    const user = (email, name, role, password, clientId = null) => {
      const existing = db.get('SELECT id FROM users WHERE email = :e', { e: email });
      if (existing) return existing.id;
      const id = newId();
      db.run('INSERT INTO users(id, email, password_hash, display_name, role, client_id) VALUES (:id, :e, :h, :n, :r, :c)', { id, e: email, h: hashPassword(password, config.passwordPepper), n: name, r: role, c: clientId });
      created.push(email);
      return id;
    };
    const ownerId = ownerEmail && ownerPassword ? user(ownerEmail.toLowerCase(), 'Owner', 'owner', ownerPassword) : null;
    if (!demo || db.get(`SELECT 1 FROM clients WHERE code = 'NST'`)) return { createdUsers: created };

    const at = '2026-01-01T00:00:00.000Z';
    const plat = (name, code, rule) => {
      const id = newId();
      db.run(`INSERT INTO platforms(id, name, code, currency) VALUES (:id, :n, :c, 'USD')`, { id, n: name, c: code });
      db.run(`INSERT INTO platform_rules(id, platform_id, effective_from, min_odds, max_odds, max_stake, max_payout, turnover_bp, turnover_base, max_outcomes_per_event, multiple_accounts_per_outcome, manual_approval, notes)
        VALUES (:id, :p, :at, :minOdds, :maxOdds, :maxStake, :maxPayout, :turnoverBp, :turnoverBase, :maxOutcomes, :multi, :manual, :notes)`, { id: newId(), p: id, at, ...rule });
      return id;
    };
    const px = plat('Platform X', 'PLTX', { minOdds: 1500, maxOdds: 0, maxStake: 50000, maxPayout: 500000, turnoverBp: 10000, turnoverBase: 'deposit', maxOutcomes: 1, multi: 0, manual: 0, notes: 'Demo rules: one outcome per account per event.' });
    const py = plat('Platform Y', 'PLTY', { minOdds: 1300, maxOdds: 10000, maxStake: 0, maxPayout: 0, turnoverBp: 30000, turnoverBase: 'deposit_plus_bonus', maxOutcomes: 2, multi: 1, manual: 0, notes: 'Demo rules: 3x deposit + bonus wagering.' });

    const movement = (clientId, kind, from, to, amount, on, note) => db.run(`INSERT INTO movements(id, client_id, kind, from_account_id, to_account_id, amount_out, amount_in, currency_out, currency_in, occurred_on, note, created_by)
      VALUES (:id, :c, :k, :f, :t, :ao, :ai, :co, :ci, :on, :n, :u)`, { id: newId(), c: clientId, k: kind, f: from, t: to, ao: from ? amount : 0, ai: to ? amount : 0, co: from ? 'USD' : null, ci: to ? 'USD' : null, on, n: note, u: ownerId });

    const demoClients = [
      { name: 'Northstar Capital', code: 'NST', investment: 1000000, share: 4000, holders: [['Dara Amini', 'NST-DA', 600000, 300000], ['Leyla Karimi', 'NST-LK', 300000, 150000]] },
      { name: 'Harbor Partners', code: 'HBR', investment: 400000, share: 5000, holders: [['Omid Farahani', 'HBR-OF', 300000, 200000]] }
    ];
    for (const c of demoClients) {
      const clientId = newId();
      db.run('INSERT INTO clients(id, name, code) VALUES (:id, :n, :c)', { id: clientId, n: c.name, c: c.code });
      db.run(`INSERT INTO shareholders(id, client_id, investment, currency, profit_share_bp, invested_on) VALUES (:id, :c, :i, 'USD', :s, '2026-07-01')`, { id: newId(), c: clientId, i: c.investment, s: c.share });
      for (const [name, code, allocated, opening] of c.holders) {
        const holderId = newId();
        db.run('INSERT INTO holders(id, client_id, name, code, allocated_capital) VALUES (:id, :c, :n, :code, :a)', { id: holderId, c: clientId, n: name, code, a: allocated });
        const acct = (kind, platformId, suffix, label) => {
          const id = newId();
          db.run(`INSERT INTO accounts(id, client_id, holder_id, kind, platform_id, name, code, username, currency) VALUES (:id, :c, :h, :k, :p, :n, :code, :u, 'USD')`,
            { id, c: clientId, h: holderId, k: kind, p: platformId, n: `${name.split(' ')[0]} ${label}`, code: `${code}-${suffix}`, u: platformId ? `${code.toLowerCase()}_${suffix.toLowerCase()}` : null });
          return id;
        };
        const wallet = acct('wallet', null, 'W', 'wallet');
        acct('bank', null, 'B', 'bank');
        const x = acct('platform', px, 'X', '· Platform X');
        const y = acct('platform', py, 'Y', '· Platform Y');
        movement(clientId, 'opening', null, wallet, opening, '2026-07-01', 'Opening balance');
        movement(clientId, 'funding', wallet, x, Math.round(opening * 0.3), '2026-07-02', 'Initial platform funding');
        movement(clientId, 'funding', wallet, y, Math.round(opening * 0.2), '2026-07-02', 'Initial platform funding');
        db.run(`INSERT INTO bonus_credits(id, account_id, kind, amount, note, credited_on) VALUES (:id, :a, 'free_bet', 2500, 'Welcome free bet', '2026-07-02')`, { id: newId(), a: x });
      }
      if (demoPassword) user(`${c.code.toLowerCase()}@atlas.local`, `${c.name} (shareholder)`, 'shareholder', demoPassword, clientId);
    }
    if (demoPassword) {
      const adminId = user('admin@atlas.local', 'Operations Admin', 'admin', demoPassword);
      const first = db.get(`SELECT id FROM clients WHERE code = 'NST'`);
      db.run('INSERT OR IGNORE INTO admin_clients(user_id, client_id) VALUES (:u, :c)', { u: adminId, c: first.id });
    }
    return { createdUsers: created };
  });
}
