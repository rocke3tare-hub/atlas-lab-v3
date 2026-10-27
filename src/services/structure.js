import crypto from 'node:crypto';
import { newId } from '../db/database.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { toMinor, parseOdds, parsePercent, assertCurrency, CURRENCIES } from '../lib/money.js';
import { text, email, oneOf, int, bool, isoDate, id as idField } from '../lib/validate.js';
import { DEFAULT_RULE, turnover, readiness } from '../domain/rules.js';
import { audit, clientFilter, loadOwned, requireClient, requireOperator, requireRole, today } from './common.js';
import { accountMoney } from './money.js';
import { hashPassword, assertPasswordPolicy, revokeAllSessions } from './auth.js';

const code = (value, field) => {
  const v = text(value, field, { required: true, max: 16 }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(v)) throw invalid(`${field} may use letters, digits and dashes.`, { field: field.toLowerCase() });
  return v;
};

// ---------- Clients & shareholders ----------

/** Client capital = shareholder investment + approved contributions. */
export function clientCapital(db, clientId) {
  const sh = db.get('SELECT investment, currency FROM shareholders WHERE client_id = :c', { c: clientId });
  if (!sh) return { capital: 0, currency: null };
  const extra = db.get(`SELECT COALESCE(sum(amount), 0) AS v FROM capital_contributions WHERE client_id = :c AND status = 'approved' AND currency = :cur`, { c: clientId, cur: sh.currency }).v;
  return { capital: sh.investment + extra, currency: sh.currency };
}

export function listClients(ctx) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'c.id');
  return ctx.db.all(`SELECT c.*, s.id AS shareholder_id, s.investment, s.currency, s.profit_share_bp, s.status AS shareholder_status,
      (SELECT COALESCE(sum(allocated_capital), 0) FROM holders h WHERE h.client_id = c.id) AS allocated
    FROM clients c LEFT JOIN shareholders s ON s.client_id = c.id WHERE ${scope.sql} ORDER BY c.name`, scope.params)
    .map(c => { const cap = clientCapital(ctx.db, c.id); return { ...c, capital: cap.capital, unallocated: cap.capital - c.allocated }; });
}

export function saveClient(ctx, input, clientId = null) {
  requireRole(ctx, 'owner');
  const fields = { name: text(input.name, 'Client name', { required: true, max: 80 }), code: code(input.code, 'Code'), status: oneOf(input.status || 'active', ['active', 'paused', 'closed'], 'Status'), note: text(input.note, 'Note', { max: 300 }) };
  try {
    if (clientId) {
      const before = loadOwned(ctx, 'clients', idField(clientId), 'Client');
      ctx.db.run('UPDATE clients SET name = :name, code = :code, status = :status, note = :note WHERE id = :id', { id: before.id, ...fields });
      audit(ctx, { action: 'client.updated', entityType: 'client', entityId: before.id, clientId: before.id, before, after: fields });
      return before.id;
    }
    const id = newId();
    ctx.db.run('INSERT INTO clients(id, name, code, status, note) VALUES (:id, :name, :code, :status, :note)', { id, ...fields });
    audit(ctx, { action: 'client.created', entityType: 'client', entityId: id, clientId: id, after: fields });
    return id;
  } catch (error) {
    if (/UNIQUE/.test(error.message)) throw conflict('DUPLICATE', 'A client with that name or code already exists.');
    throw error;
  }
}

export function saveShareholder(ctx, clientId, input) {
  requireRole(ctx, 'owner');
  const client = loadOwned(ctx, 'clients', idField(clientId), 'Client');
  const currency = assertCurrency(String(input.currency || 'USD').toUpperCase());
  const fields = {
    investment: toMinor(input.investment, currency, 'Investment', { allowZero: false }), currency,
    share: parsePercent(input.profitSharePercent, 'Profit share'), on: isoDate(input.investedOn || today(), 'Investment date'),
    status: oneOf(input.status || 'active', ['active', 'paused'], 'Status')
  };
  const existing = ctx.db.get('SELECT * FROM shareholders WHERE client_id = :c', { c: client.id });
  if (existing) {
    if (existing.currency !== currency && ctx.db.get('SELECT 1 FROM capital_contributions WHERE client_id = :c', { c: client.id })) throw invalid('The currency cannot change once contributions exist.');
    ctx.db.run('UPDATE shareholders SET investment = :investment, currency = :currency, profit_share_bp = :share, invested_on = :on, status = :status WHERE id = :id', { id: existing.id, ...fields });
  } else {
    ctx.db.run('INSERT INTO shareholders(id, client_id, investment, currency, profit_share_bp, invested_on, status) VALUES (:id, :c, :investment, :currency, :share, :on, :status)', { id: newId(), c: client.id, ...fields });
  }
  const allocated = ctx.db.get('SELECT COALESCE(sum(allocated_capital), 0) AS v FROM holders WHERE client_id = :c', { c: client.id }).v;
  if (clientCapital(ctx.db, client.id).capital < allocated) throw invalid('Holders already have more capital allocated than this investment. Reduce their allocations first.');
  audit(ctx, { action: existing ? 'shareholder.updated' : 'shareholder.created', entityType: 'client', entityId: client.id, clientId: client.id, before: existing, after: fields });
}

export function requestContribution(ctx, input) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const clientId = idField(input.clientId, 'Client');
  requireClient(ctx, clientId);
  const sh = ctx.db.get('SELECT * FROM shareholders WHERE client_id = :c', { c: clientId });
  if (!sh) throw invalid('Create the shareholder profile first.');
  const id = newId();
  ctx.db.run('INSERT INTO capital_contributions(id, client_id, amount, currency, note, requested_by) VALUES (:id, :c, :a, :cur, :n, :u)',
    { id, c: clientId, a: toMinor(input.amount, sh.currency, 'Amount', { allowZero: false }), cur: sh.currency, n: text(input.note, 'Note', { max: 300 }), u: ctx.actor.userId });
  audit(ctx, { action: 'capital.requested', entityType: 'capital_contribution', entityId: id, clientId });
  return id;
}

export function decideContribution(ctx, id, input) {
  requireRole(ctx, 'owner');
  const row = loadOwned(ctx, 'capital_contributions', idField(id), 'Contribution');
  if (row.status !== 'pending') throw new AppError('ALREADY_DECIDED', 'This request was already decided.', 409);
  const status = oneOf(input.decision, ['approved', 'rejected'], 'Decision');
  ctx.db.run(`UPDATE capital_contributions SET status = :s, decided_by = :u, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: row.id, s: status, u: ctx.actor.userId });
  audit(ctx, { action: `capital.${status}`, entityType: 'capital_contribution', entityId: row.id, clientId: row.client_id, reason: text(input.note, 'Note', { max: 300 }) });
}

export function listContributions(ctx) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'k.client_id');
  return ctx.db.all(`SELECT k.*, c.name AS client_name, u.display_name AS requested_by_name FROM capital_contributions k JOIN clients c ON c.id = k.client_id JOIN users u ON u.id = k.requested_by WHERE ${scope.sql} ORDER BY k.created_at DESC`, scope.params);
}

// ---------- Holders ----------

export function saveHolder(ctx, input, holderId = null) {
  requireOperator(ctx);
  const clientId = idField(input.clientId, 'Client');
  requireClient(ctx, clientId);
  const { capital, currency } = clientCapital(ctx.db, clientId);
  if (!currency) throw invalid('Create the client’s shareholder profile before adding holders.');
  const fields = { name: text(input.name, 'Name', { required: true, max: 80 }), code: code(input.code, 'Code'), allocated: toMinor(input.allocatedCapital || 0, currency, 'Allocated capital'), status: oneOf(input.status || 'active', ['active', 'paused'], 'Status'), note: text(input.note, 'Note', { max: 300 }) };
  const others = ctx.db.get('SELECT COALESCE(sum(allocated_capital), 0) AS v FROM holders WHERE client_id = :c AND id <> :id', { c: clientId, id: holderId || '' }).v;
  if (others + fields.allocated > capital) throw invalid(`Only ${((capital - others) / 10 ** CURRENCIES[currency].decimals).toLocaleString('en-US')} ${currency} of this client’s capital is unallocated.`, { field: 'allocatedCapital' });
  try {
    if (holderId) {
      const before = loadOwned(ctx, 'holders', idField(holderId), 'Holder');
      if (before.client_id !== clientId) throw invalid('A holder cannot move to another client.');
      ctx.db.run('UPDATE holders SET name = :name, code = :code, allocated_capital = :allocated, status = :status, note = :note WHERE id = :id', { id: before.id, ...fields });
      audit(ctx, { action: 'holder.updated', entityType: 'holder', entityId: before.id, clientId, before, after: fields });
      return before.id;
    }
    const id = newId();
    ctx.db.run('INSERT INTO holders(id, client_id, name, code, allocated_capital, status, note) VALUES (:id, :c, :name, :code, :allocated, :status, :note)', { id, c: clientId, ...fields });
    audit(ctx, { action: 'holder.created', entityType: 'holder', entityId: id, clientId, after: fields });
    return id;
  } catch (error) {
    if (/UNIQUE/.test(error.message)) throw conflict('DUPLICATE', 'That holder code is already used.');
    throw error;
  }
}

// ---------- Accounts ----------

export function saveAccount(ctx, input, accountId = null) {
  requireOperator(ctx);
  if (accountId) {
    const before = loadOwned(ctx, 'accounts', idField(accountId), 'Account');
    const fields = { name: text(input.name ?? before.name, 'Name', { required: true, max: 80 }), username: text(input.username ?? before.username, 'Username', { max: 80 }), status: oneOf(input.status ?? before.status, ['active', 'paused', 'closed'], 'Status'), kyc: oneOf(input.kycStatus ?? before.kyc_status, ['verified', 'pending', 'rejected'], 'Verification') };
    if (fields.status === 'closed' && accountMoney(ctx.db, before).balance !== 0) throw invalid('Move the balance out before closing the account.');
    ctx.db.run('UPDATE accounts SET name = :name, username = :username, status = :status, kyc_status = :kyc WHERE id = :id', { id: before.id, ...fields });
    audit(ctx, { action: 'account.updated', entityType: 'account', entityId: before.id, clientId: before.client_id, before, after: fields });
    return before.id;
  }
  const holder = loadOwned(ctx, 'holders', idField(input.holderId, 'Holder'), 'Holder');
  const kind = oneOf(input.kind, ['wallet', 'bank', 'platform'], 'Account type');
  let platform = null;
  if (kind === 'platform') {
    platform = ctx.db.get('SELECT * FROM platforms WHERE id = :id', { id: idField(input.platformId, 'Platform') });
    if (!platform) throw notFound('Platform');
  }
  const currency = platform ? platform.currency : assertCurrency(String(input.currency || 'USD').toUpperCase());
  const id = newId();
  try {
    ctx.db.run(`INSERT INTO accounts(id, client_id, holder_id, kind, platform_id, name, code, username, currency, kyc_status) VALUES (:id, :c, :h, :k, :p, :name, :code, :user, :cur, :kyc)`, {
      id, c: holder.client_id, h: holder.id, k: kind, p: platform?.id ?? null,
      name: text(input.name, 'Name', { max: 80 }) || `${holder.name} ${platform ? platform.name : kind === 'wallet' ? 'wallet' : 'bank'}`,
      code: code(input.code, 'Code'), user: text(input.username, 'Username', { max: 80 }), cur: currency, kyc: oneOf(input.kycStatus || 'verified', ['verified', 'pending', 'rejected'], 'Verification')
    });
  } catch (error) {
    if (/UNIQUE/.test(error.message) && /accounts.code/.test(error.message)) throw conflict('DUPLICATE', 'That account code is already used.');
    if (/UNIQUE/.test(error.message)) throw conflict('DUPLICATE', kind === 'platform' ? 'This holder already has an account on that platform.' : `This holder already has a ${currency} ${kind}.`);
    throw error;
  }
  audit(ctx, { action: 'account.created', entityType: 'account', entityId: id, clientId: holder.client_id, after: { kind, currency } });
  return id;
}

/** Rule in force for a platform at an instant (falls back to safe defaults). */
export function ruleFor(db, platformId, at = new Date().toISOString()) {
  const row = db.get('SELECT * FROM platform_rules WHERE platform_id = :p AND effective_from <= :at ORDER BY effective_from DESC LIMIT 1', { p: platformId, at });
  if (!row) return { id: null, ...DEFAULT_RULE };
  return { id: row.id, effectiveFrom: row.effective_from, minOdds: row.min_odds, maxOdds: row.max_odds, maxStake: row.max_stake, maxPayout: row.max_payout, turnoverBp: row.turnover_bp, turnoverBase: row.turnover_base, maxOutcomesPerEvent: row.max_outcomes_per_event, multipleAccountsPerOutcome: Boolean(row.multiple_accounts_per_outcome), manualApproval: Boolean(row.manual_approval), notes: row.notes };
}

export function turnoverFor(db, account, rule = ruleFor(db, account.platform_id)) {
  const deposits = db.get(`SELECT COALESCE(sum(amount_in), 0) AS v FROM movements WHERE to_account_id = :a AND kind = 'funding'`, { a: account.id }).v
    - db.get(`SELECT COALESCE(sum(amount_out), 0) AS v FROM movements WHERE from_account_id = :a AND kind = 'reversal' AND reverses_id IN (SELECT id FROM movements WHERE kind = 'funding' AND to_account_id = :a)`, { a: account.id }).v;
  const bonus = db.get(`SELECT COALESCE(sum(amount), 0) AS v FROM bonus_credits WHERE account_id = :a AND kind = 'bonus'`, { a: account.id }).v;
  const eligible = db.get(`SELECT COALESCE(sum(stake), 0) AS v FROM bets WHERE account_id = :a AND status IN ('won','lost') AND stake_type IN ('cash','bonus') AND odds >= :min`, { a: account.id, min: rule.minOdds }).v;
  return turnover({ deposits, bonusCredited: bonus, eligibleStakes: eligible }, rule);
}

export function describeAccount(db, a) {
  const money = accountMoney(db, a);
  const base = { id: a.id, clientId: a.client_id, holderId: a.holder_id, kind: a.kind, platformId: a.platform_id, name: a.name, code: a.code, username: a.username, currency: a.currency, status: a.status, kycStatus: a.kyc_status, ...money };
  if (a.kind !== 'platform') return base;
  const rule = ruleFor(db, a.platform_id);
  const t = turnoverFor(db, a, rule);
  return { ...base, turnover: t, readiness: readiness({ account: { status: a.status, kycStatus: a.kyc_status }, available: money.available, turnoverInfo: t, pendingWithdrawals: money.pendingWithdrawals }) };
}

/** Client > holder > accounts tree with live balances. */
export function structure(ctx, { clientId = '' } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const clients = listClients(ctx).filter(c => !clientId || c.id === clientId);
  const ids = clients.map(c => c.id);
  if (!ids.length) return [];
  const params = Object.fromEntries(ids.map((id, i) => [`c${i}`, id]));
  const list = ids.map((_, i) => `:c${i}`).join(', ');
  const holders = ctx.db.all(`SELECT * FROM holders WHERE client_id IN (${list}) ORDER BY name`, params);
  const accounts = ctx.db.all(`SELECT a.*, p.name AS platform_name FROM accounts a LEFT JOIN platforms p ON p.id = a.platform_id WHERE a.client_id IN (${list}) ORDER BY CASE a.kind WHEN 'wallet' THEN 0 WHEN 'bank' THEN 1 ELSE 2 END, a.name`, params);
  return clients.map(c => ({
    ...c,
    holders: holders.filter(h => h.client_id === c.id).map(h => ({ ...h, accounts: accounts.filter(a => a.holder_id === h.id).map(a => ({ ...describeAccount(ctx.db, a), platformName: a.platform_name })) }))
  }));
}

// ---------- Platforms & rules ----------

export function listPlatforms(ctx) {
  requireRole(ctx, 'owner', 'admin');
  return ctx.db.all('SELECT * FROM platforms ORDER BY name').map(p => ({ ...p, rule: ruleFor(ctx.db, p.id), history: ctx.db.all('SELECT id, effective_from, notes, created_at FROM platform_rules WHERE platform_id = :p ORDER BY effective_from DESC', { p: p.id }) }));
}

export function savePlatform(ctx, input, platformId = null) {
  requireRole(ctx, 'owner');
  const fields = { name: text(input.name, 'Platform name', { required: true, max: 60 }), code: code(input.code, 'Code'), currency: assertCurrency(String(input.currency || 'USD').toUpperCase()), status: oneOf(input.status || 'active', ['active', 'paused'], 'Status') };
  try {
    if (platformId) {
      const before = ctx.db.get('SELECT * FROM platforms WHERE id = :id', { id: idField(platformId) });
      if (!before) throw notFound('Platform');
      if (before.currency !== fields.currency && ctx.db.get('SELECT 1 FROM accounts WHERE platform_id = :p', { p: before.id })) throw invalid('The currency cannot change once accounts exist on this platform.');
      ctx.db.run('UPDATE platforms SET name = :name, code = :code, currency = :currency, status = :status WHERE id = :id', { id: before.id, ...fields });
      audit(ctx, { action: 'platform.updated', entityType: 'platform', entityId: before.id, before, after: fields });
      return before.id;
    }
    const id = newId();
    ctx.db.run('INSERT INTO platforms(id, name, code, currency, status) VALUES (:id, :name, :code, :currency, :status)', { id, ...fields });
    audit(ctx, { action: 'platform.created', entityType: 'platform', entityId: id, after: fields });
    return id;
  } catch (error) {
    if (/UNIQUE/.test(error.message)) throw conflict('DUPLICATE', 'A platform with that name or code exists.');
    throw error;
  }
}

/** New rule version, effective now (or a future time). Old versions stay for history and snapshots. */
export function addRuleVersion(ctx, platformId, input) {
  requireRole(ctx, 'owner');
  const platform = ctx.db.get('SELECT * FROM platforms WHERE id = :id', { id: idField(platformId) });
  if (!platform) throw notFound('Platform');
  const cur = platform.currency;
  const optionalMoney = (v, f) => (v === '' || v == null ? 0 : toMinor(v, cur, f));
  const rule = {
    minOdds: input.minOdds === '' || input.minOdds == null ? 1000 : parseOdds(input.minOdds, 'Minimum odds'),
    maxOdds: input.maxOdds === '' || input.maxOdds == null ? 0 : parseOdds(input.maxOdds, 'Maximum odds'),
    maxStake: optionalMoney(input.maxStake, 'Maximum stake'),
    maxPayout: optionalMoney(input.maxPayout, 'Maximum payout'),
    turnoverBp: parsePercent(input.turnoverPercent ?? 100, 'Turnover', { max: 10000 }),
    turnoverBase: oneOf(input.turnoverBase || 'deposit', ['deposit', 'bonus', 'deposit_plus_bonus'], 'Turnover base'),
    maxOutcomes: int(input.maxOutcomesPerEvent ?? 1, 'Outcomes per event', { min: 1, max: 3 }),
    multi: bool(input.multipleAccountsPerOutcome) ? 1 : 0,
    manual: bool(input.manualApproval) ? 1 : 0,
    notes: text(input.notes, 'Notes', { max: 500 })
  };
  if (rule.maxOdds && rule.maxOdds < rule.minOdds) throw invalid('Maximum odds are below the minimum odds.');
  const latest = ctx.db.get('SELECT max(effective_from) AS at FROM platform_rules WHERE platform_id = :p', { p: platform.id })?.at;
  const requested = input.effectiveFrom ? new Date(`${isoDate(input.effectiveFrom, 'Effective date')}T00:00:00Z`).getTime() : Date.now();
  const effective = new Date(Math.max(requested, latest ? Date.parse(latest) + 1 : 0)).toISOString();
  const id = newId();
  ctx.db.run(`INSERT INTO platform_rules(id, platform_id, effective_from, min_odds, max_odds, max_stake, max_payout, turnover_bp, turnover_base, max_outcomes_per_event, multiple_accounts_per_outcome, manual_approval, notes, created_by)
    VALUES (:id, :p, :e, :minOdds, :maxOdds, :maxStake, :maxPayout, :turnoverBp, :turnoverBase, :maxOutcomes, :multi, :manual, :notes, :u)`, { id, p: platform.id, e: effective, u: ctx.actor.userId, ...rule });
  audit(ctx, { action: 'platform.rule_versioned', entityType: 'platform', entityId: platform.id, after: rule });
  return id;
}

// ---------- Users (sign-in) ----------

export function listUsers(ctx) {
  requireRole(ctx, 'owner');
  return ctx.db.all(`SELECT u.id, u.email, u.display_name, u.role, u.client_id, u.status, u.last_login_at, c.name AS client_name FROM users u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.role, u.display_name`)
    .map(u => ({ ...u, clients: u.role === 'admin' ? ctx.db.all('SELECT client_id FROM admin_clients WHERE user_id = :u', { u: u.id }).map(r => r.client_id) : [] }));
}

export function createUser(ctx, config, input) {
  requireRole(ctx, 'owner');
  const role = oneOf(input.role, ['admin', 'shareholder', 'owner'], 'Role');
  const clientId = role === 'shareholder' ? idField(input.clientId, 'Client') : null;
  if (clientId && !ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id: clientId })) throw notFound('Client');
  const address = email(input.email);
  if (ctx.db.get('SELECT 1 FROM users WHERE email = :e', { e: address })) throw conflict('DUPLICATE', 'A user with this email exists.');
  const temporaryPassword = crypto.randomBytes(9).toString('base64url');
  const id = newId();
  ctx.db.run('INSERT INTO users(id, email, password_hash, display_name, role, client_id) VALUES (:id, :e, :h, :n, :r, :c)', { id, e: address, h: hashPassword(temporaryPassword, config.passwordPepper), n: text(input.displayName, 'Name', { required: true, max: 80 }), r: role, c: clientId });
  if (role === 'admin') setAdminClients(ctx, id, input.clientIds || []);
  audit(ctx, { action: 'user.created', entityType: 'user', entityId: id, after: { email: address, role } });
  return { id, email: address, temporaryPassword };
}

export function setAdminClients(ctx, userId, clientIds) {
  requireRole(ctx, 'owner');
  const user = ctx.db.get('SELECT * FROM users WHERE id = :id', { id: userId });
  if (!user || user.role !== 'admin') throw invalid('Client assignments apply to admins.');
  if (!Array.isArray(clientIds)) throw invalid('Client list is not valid.', { field: 'clientIds' });
  ctx.db.run('DELETE FROM admin_clients WHERE user_id = :u', { u: userId });
  for (const c of new Set(clientIds.map(x => idField(x, 'Client')))) {
    if (!ctx.db.get('SELECT 1 FROM clients WHERE id = :id', { id: c })) throw notFound('Client');
    ctx.db.run('INSERT INTO admin_clients(user_id, client_id) VALUES (:u, :c)', { u: userId, c });
  }
  audit(ctx, { action: 'user.clients_assigned', entityType: 'user', entityId: userId, after: clientIds });
}

export function setUserStatus(ctx, userId, status) {
  requireRole(ctx, 'owner');
  if (userId === ctx.actor.userId) throw forbidden('You cannot suspend yourself.');
  const s = oneOf(status, ['active', 'suspended'], 'Status');
  if (!ctx.db.get('SELECT 1 FROM users WHERE id = :id', { id: userId })) throw notFound('User');
  ctx.db.run('UPDATE users SET status = :s WHERE id = :id', { id: userId, s });
  if (s === 'suspended') revokeAllSessions(ctx.db, userId);
  audit(ctx, { action: `user.${s}`, entityType: 'user', entityId: userId });
}

export function changePassword(ctx, config, input, verify) {
  const user = ctx.db.get('SELECT * FROM users WHERE id = :id', { id: ctx.actor.userId });
  if (!verify(String(input.currentPassword || ''), user.password_hash, config.passwordPepper)) throw new AppError('WRONG_PASSWORD', 'Your current password is incorrect.', 403);
  assertPasswordPolicy(input.newPassword);
  ctx.db.run('UPDATE users SET password_hash = :h WHERE id = :id', { id: user.id, h: hashPassword(input.newPassword, config.passwordPepper) });
  revokeAllSessions(ctx.db, user.id);
  audit(ctx, { action: 'user.password_changed', entityType: 'user', entityId: user.id });
}
