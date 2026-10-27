import { newId } from '../db/database.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { toMinor, CURRENCIES } from '../lib/money.js';
import { text, isoDate, oneOf, id as idField } from '../lib/validate.js';
import { audit, clientFilter, loadOwned, requireOperator, requireRole, today, openTask, closeTasks } from './common.js';

// ---------- Derived balances ----------

export function ledgerBalance(db, accountId) {
  const r = db.get(`SELECT
      COALESCE((SELECT sum(amount_in) FROM movements WHERE to_account_id = :a), 0) AS inflow,
      COALESCE((SELECT sum(amount_out + fee) FROM movements WHERE from_account_id = :a), 0) AS outflow`, { a: accountId });
  return r.inflow - r.outflow;
}

const OPEN_WITHDRAWAL = "('requested','delayed','verification','problem')";

/** Everything a screen needs about one account's money. */
export function accountMoney(db, account) {
  const balance = ledgerBalance(db, account.id);
  if (account.kind !== 'platform') return { balance, available: balance, reserved: 0, pendingWithdrawals: 0, bonus: 0, freeBet: 0 };
  const reserved = db.get(`SELECT COALESCE(sum(stake), 0) AS v FROM bets WHERE account_id = :a AND status = 'reserved' AND stake_type = 'cash'`, { a: account.id }).v;
  const pendingWithdrawals = db.get(`SELECT COALESCE(sum(amount), 0) AS v FROM withdrawals WHERE platform_account_id = :a AND status IN ${OPEN_WITHDRAWAL}`, { a: account.id }).v;
  const pocket = kind => db.get(`SELECT
      COALESCE((SELECT sum(amount) FROM bonus_credits WHERE account_id = :a AND kind = :k), 0) -
      COALESCE((SELECT sum(stake) FROM bets WHERE account_id = :a AND stake_type = :k AND status <> 'cancelled'), 0) -
      COALESCE((SELECT sum(CASE WHEN :k = 'bonus' THEN bonus_stake ELSE free_bet_stake END) FROM mixes WHERE account_id = :a AND status <> 'draft'), 0) AS v`, { a: account.id, k: kind }).v;
  return { balance, available: balance - reserved - pendingWithdrawals, reserved, pendingWithdrawals, bonus: pocket('bonus'), freeBet: pocket('free_bet') };
}

// ---------- Posting ----------

/**
 * Post one journal line. Checks currencies match the accounts, that the
 * accounts belong to the client, and that the source has enough available
 * money (no overdrafts) unless `allowOverdraft` (used for stakes already
 * reserved, whose availability was checked at reservation time).
 */
export function post(ctx, { clientId, kind, from = null, to = null, amountOut = 0, amountIn = 0, fee = 0, occurredOn = today(), note = null, reference = null, sourceType = null, sourceId = null, reversesId = null, allowOverdraft = false, extraAvailable = 0 }) {
  const fromAccount = from ? ctx.db.get('SELECT * FROM accounts WHERE id = :id', { id: from }) : null;
  const toAccount = to ? ctx.db.get('SELECT * FROM accounts WHERE id = :id', { id: to }) : null;
  if (from && !fromAccount) throw notFound('Source account');
  if (to && !toAccount) throw notFound('Destination account');
  for (const a of [fromAccount, toAccount]) if (a && a.client_id !== clientId) throw invalid('Both accounts must belong to the same client.');
  if (fromAccount && !allowOverdraft) {
    const available = accountMoney(ctx.db, fromAccount).available + extraAvailable;
    if (amountOut + fee > available) throw new AppError('INSUFFICIENT_FUNDS', `${fromAccount.name} has only ${(available / 10 ** CURRENCIES[fromAccount.currency].decimals).toLocaleString('en-US')} ${fromAccount.currency} available.`, 422);
  }
  const id = newId();
  ctx.db.run(`INSERT INTO movements(id, client_id, kind, from_account_id, to_account_id, amount_out, amount_in, fee, currency_out, currency_in, occurred_on, note, reference, source_type, source_id, reverses_id, created_by)
    VALUES (:id, :c, :k, :f, :t, :ao, :ai, :fee, :co, :ci, :on, :note, :ref, :st, :si, :rev, :u)`, {
    id, c: clientId, k: kind, f: from, t: to, ao: from ? amountOut : 0, ai: to ? amountIn : 0, fee: from ? fee : 0,
    co: fromAccount?.currency ?? null, ci: toAccount?.currency ?? null, on: occurredOn, note, ref: reference, st: sourceType, si: sourceId, rev: reversesId, u: ctx.actor?.userId ?? null
  });
  return id;
}

function account(ctx, id, label = 'Account') {
  return loadOwned(ctx, 'accounts', idField(id, label), label);
}

// ---------- Use cases ----------

const MANUAL_KINDS = ['opening', 'capital', 'transfer', 'exchange', 'income', 'cost', 'adjustment'];

/**
 * Record money manually:
 * - opening/capital/income: outside -> account
 * - cost: account -> outside
 * - transfer: account -> account, same currency, optional fee paid by the sender
 * - exchange: account -> account, different currencies, explicit amounts on both sides
 */
export function recordMovement(ctx, input) {
  requireOperator(ctx);
  const kind = oneOf(input.kind, MANUAL_KINDS, 'Movement type');
  const occurredOn = isoDate(input.occurredOn || today(), 'Date');
  const note = text(input.note, 'Note', { max: 300 });
  const reference = text(input.reference, 'Reference', { max: 80 });
  let id; let clientId;
  if (['opening', 'capital', 'income'].includes(kind)) {
    const to = account(ctx, input.toAccountId, 'Destination account');
    clientId = to.client_id;
    id = post(ctx, { clientId, kind, to: to.id, amountIn: toMinor(input.amount, to.currency, 'Amount', { allowZero: false }), occurredOn, note, reference });
  } else if (kind === 'cost') {
    const from = account(ctx, input.fromAccountId, 'Source account');
    clientId = from.client_id;
    id = post(ctx, { clientId, kind, from: from.id, amountOut: toMinor(input.amount, from.currency, 'Amount', { allowZero: false }), occurredOn, note: note || text(input.category, 'Category', { max: 60 }), reference });
  } else if (kind === 'adjustment') {
    requireRole(ctx, 'owner');
    const target = account(ctx, input.accountId, 'Account');
    clientId = target.client_id;
    const amount = toMinor(input.amount, target.currency, 'Amount', { allowNegative: true, allowZero: false });
    if (!note) throw invalid('Explain the adjustment.', { field: 'note' });
    id = amount > 0 ? post(ctx, { clientId, kind, to: target.id, amountIn: amount, occurredOn, note }) : post(ctx, { clientId, kind, from: target.id, amountOut: -amount, occurredOn, note, allowOverdraft: true });
  } else {
    const from = account(ctx, input.fromAccountId, 'Source account');
    const to = account(ctx, input.toAccountId, 'Destination account');
    if (from.id === to.id) throw invalid('Choose two different accounts.');
    if (from.client_id !== to.client_id) throw invalid('Money can only move between accounts of the same client.');
    if (from.kind === 'platform' || to.kind === 'platform') throw invalid('Use platform funding and withdrawals to move money in or out of a platform.');
    clientId = from.client_id;
    if (kind === 'transfer') {
      if (from.currency !== to.currency) throw invalid('Accounts use different currencies. Use an exchange instead.');
      const amount = toMinor(input.amount, from.currency, 'Amount', { allowZero: false });
      id = post(ctx, { clientId, kind, from: from.id, to: to.id, amountOut: amount, amountIn: amount, fee: toMinor(input.fee || 0, from.currency, 'Fee'), occurredOn, note, reference });
    } else {
      if (from.currency === to.currency) throw invalid('Both accounts use the same currency. Use a transfer instead.');
      id = post(ctx, { clientId, kind, from: from.id, to: to.id, amountOut: toMinor(input.amount, from.currency, 'Amount sent', { allowZero: false }), amountIn: toMinor(input.amountReceived, to.currency, 'Amount received', { allowZero: false }), fee: toMinor(input.fee || 0, from.currency, 'Fee'), occurredOn, note, reference });
    }
  }
  audit(ctx, { action: `money.${kind}`, entityType: 'movement', entityId: id, clientId, after: { kind, amount: input.amount, note } });
  return getMovement(ctx, id);
}

/** Corrections never edit history: they post an equal and opposite movement. */
export function reverseMovement(ctx, movementId, input) {
  requireRole(ctx, 'owner');
  const m = loadOwned(ctx, 'movements', idField(movementId, 'Movement'), 'Movement');
  if (m.kind === 'reversal') throw invalid('A reversal cannot itself be reversed; post a new movement instead.');
  if (m.source_type) throw invalid('This movement belongs to a workflow (bet, withdrawal or payment). Correct it from there.');
  if (ctx.db.get('SELECT 1 FROM movements WHERE reverses_id = :id', { id: m.id })) throw new AppError('ALREADY_REVERSED', 'This movement was already reversed.', 409);
  const reason = text(input.reason, 'Reason', { required: true, max: 300 });
  const id = post(ctx, { clientId: m.client_id, kind: 'reversal', from: m.to_account_id, to: m.from_account_id, amountOut: m.amount_in, amountIn: m.amount_out + m.fee, occurredOn: today(), note: reason, reversesId: m.id, allowOverdraft: true });
  audit(ctx, { action: 'money.reversal', entityType: 'movement', entityId: m.id, clientId: m.client_id, reason });
  return getMovement(ctx, id);
}

export function getMovement(ctx, id) {
  return listMovements(ctx, { id })[0];
}

export function listMovements(ctx, { id = null, clientId = '', accountId = '', from = '', to = '', limit = 300 } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'm.client_id');
  const p = { ...scope.params, limit: Math.min(Math.max(Number(limit) || 300, 1), 1000) };
  const where = [scope.sql];
  if (id) { p.id = id; where.push('m.id = :id'); }
  if (clientId) { p.client = clientId; where.push('m.client_id = :client'); }
  if (accountId) { p.account = accountId; where.push('(m.from_account_id = :account OR m.to_account_id = :account)'); }
  if (from) { p.from = isoDate(from, 'From'); where.push('m.occurred_on >= :from'); }
  if (to) { p.to = isoDate(to, 'To'); where.push('m.occurred_on <= :to'); }
  return ctx.db.all(`SELECT m.*, fa.name AS from_name, ta.name AS to_name, c.name AS client_name, u.display_name AS created_by_name,
      (SELECT 1 FROM movements r WHERE r.reverses_id = m.id) AS reversed
    FROM movements m LEFT JOIN accounts fa ON fa.id = m.from_account_id LEFT JOIN accounts ta ON ta.id = m.to_account_id
    JOIN clients c ON c.id = m.client_id LEFT JOIN users u ON u.id = m.created_by
    WHERE ${where.join(' AND ')} ORDER BY m.occurred_on DESC, m.created_at DESC LIMIT :limit`, p)
    .map(r => ({ ...r, reversed: Boolean(r.reversed) }));
}

// ---------- Platform funding & withdrawals ----------

export function fundPlatform(ctx, input) {
  requireOperator(ctx);
  const from = account(ctx, input.fromAccountId, 'Source account');
  const to = account(ctx, input.platformAccountId, 'Platform account');
  if (to.kind !== 'platform') throw invalid('Choose a platform account to fund.');
  if (from.kind === 'platform') throw invalid('Fund platforms from a wallet or bank.');
  if (from.holder_id !== to.holder_id) throw invalid('Funding must come from the same holder’s own wallet or bank.');
  if (from.currency !== to.currency) throw invalid(`The platform account uses ${to.currency}; exchange money into a ${to.currency} account first.`);
  if (to.status !== 'active') throw invalid('This platform account is not active.');
  const amount = toMinor(input.amount, from.currency, 'Amount', { allowZero: false });
  const id = post(ctx, { clientId: from.client_id, kind: 'funding', from: from.id, to: to.id, amountOut: amount, amountIn: amount, fee: toMinor(input.fee || 0, from.currency, 'Fee'), occurredOn: isoDate(input.occurredOn || today(), 'Date'), note: text(input.note, 'Note', { max: 300 }), reference: text(input.reference, 'Reference', { max: 80 }) });
  audit(ctx, { action: 'platform.funded', entityType: 'account', entityId: to.id, clientId: from.client_id, after: { amount, from: from.name } });
  return getMovement(ctx, id);
}

export function creditBonus(ctx, input) {
  requireOperator(ctx);
  const target = account(ctx, input.accountId, 'Platform account');
  if (target.kind !== 'platform') throw invalid('Bonuses are credited to platform accounts.');
  const kind = oneOf(input.kind, ['bonus', 'free_bet'], 'Bonus type');
  const amount = toMinor(input.amount, target.currency, 'Amount', { allowZero: false });
  ctx.db.run('INSERT INTO bonus_credits(id, account_id, kind, amount, note, credited_on, created_by) VALUES (:id, :a, :k, :amt, :n, :on, :u)',
    { id: newId(), a: target.id, k: kind, amt: amount, n: text(input.note, 'Note', { max: 200 }), on: isoDate(input.creditedOn || today(), 'Date'), u: ctx.actor.userId });
  audit(ctx, { action: 'platform.bonus_credited', entityType: 'account', entityId: target.id, clientId: target.client_id, after: { kind, amount } });
  return { ok: true };
}

export function requestWithdrawal(ctx, input) {
  requireOperator(ctx);
  const platform = account(ctx, input.platformAccountId, 'Platform account');
  const dest = account(ctx, input.destinationAccountId, 'Destination account');
  if (platform.kind !== 'platform') throw invalid('Withdrawals come from a platform account.');
  if (dest.kind === 'platform') throw invalid('Withdraw to a wallet or bank.');
  if (dest.holder_id !== platform.holder_id) throw invalid('Withdrawals can only go to the same holder’s own wallet or bank.');
  if (dest.currency !== platform.currency) throw invalid(`Choose a ${platform.currency} destination account.`);
  const amount = toMinor(input.amount, platform.currency, 'Amount', { allowZero: false });
  const money = accountMoney(ctx.db, platform);
  if (amount > money.available) throw new AppError('INSUFFICIENT_FUNDS', 'The amount is more than the available platform balance.', 422);
  const id = newId();
  const requestedOn = isoDate(input.requestedOn || today(), 'Requested on');
  const expectedOn = input.expectedOn ? isoDate(input.expectedOn, 'Expected on') : null;
  if (expectedOn && expectedOn < requestedOn) throw invalid('The expected date is before the request date.');
  ctx.db.run(`INSERT INTO withdrawals(id, client_id, platform_account_id, destination_account_id, amount, requested_on, expected_on, created_by) VALUES (:id, :c, :p, :d, :a, :r, :e, :u)`,
    { id, c: platform.client_id, p: platform.id, d: dest.id, a: amount, r: requestedOn, e: expectedOn, u: ctx.actor.userId });
  openTask(ctx, { clientId: platform.client_id, title: `Confirm arrival of withdrawal from ${platform.name}`, sourceType: 'withdrawal', sourceId: id, priority: 'high', dueOn: expectedOn });
  audit(ctx, { action: 'withdrawal.requested', entityType: 'withdrawal', entityId: id, clientId: platform.client_id, after: { amount } });
  return getWithdrawal(ctx, id);
}

const WITHDRAWAL_FLOW = { requested: ['delayed', 'verification', 'problem', 'received', 'cancelled'], delayed: ['verification', 'problem', 'received', 'cancelled'], verification: ['delayed', 'problem', 'received', 'cancelled'], problem: ['delayed', 'verification', 'received', 'cancelled'] };

/** Update status; on "received" the money moves platform -> destination, and any shortfall is booked as a fee. */
export function updateWithdrawal(ctx, withdrawalId, input) {
  requireOperator(ctx);
  const w = loadOwned(ctx, 'withdrawals', idField(withdrawalId, 'Withdrawal'), 'Withdrawal');
  const status = oneOf(input.status, ['delayed', 'verification', 'problem', 'received', 'cancelled'], 'Status');
  if (!(WITHDRAWAL_FLOW[w.status] || []).includes(status)) throw new AppError('INVALID_STATUS_TRANSITION', `A ${w.status} withdrawal cannot become ${status}.`, 422);
  const reason = text(input.reason, 'Reason', { required: ['delayed', 'verification', 'problem', 'cancelled'].includes(status), max: 300 });
  let movementId = null; let receivedAmount = null; let receivedOn = null;
  if (status === 'received') {
    const platform = ctx.db.get('SELECT * FROM accounts WHERE id = :id', { id: w.platform_account_id });
    receivedAmount = toMinor(input.receivedAmount, platform.currency, 'Amount received', { allowZero: false });
    if (receivedAmount > w.amount) throw invalid('More arrived than was withdrawn. Record the extra as income.');
    receivedOn = isoDate(input.receivedOn || today(), 'Received on');
    if (receivedOn < w.requested_on) throw invalid('Arrival date is before the request date.');
    movementId = post(ctx, { clientId: w.client_id, kind: 'withdrawal', from: w.platform_account_id, to: w.destination_account_id, amountOut: receivedAmount, amountIn: receivedAmount, fee: w.amount - receivedAmount, occurredOn: receivedOn, note: reason, sourceType: 'withdrawal', sourceId: w.id, extraAvailable: w.amount });
  }
  ctx.db.run(`UPDATE withdrawals SET status = :s, reason = COALESCE(:r, reason), received_amount = :ra, received_on = :ro, movement_id = :m, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`,
    { id: w.id, s: status, r: reason, ra: receivedAmount, ro: receivedOn, m: movementId });
  if (status === 'received' || status === 'cancelled') closeTasks(ctx, 'withdrawal', w.id);
  audit(ctx, { action: `withdrawal.${status}`, entityType: 'withdrawal', entityId: w.id, clientId: w.client_id, before: { status: w.status }, after: { status, receivedAmount }, reason });
  return getWithdrawal(ctx, w.id);
}

export function listWithdrawals(ctx, { status = '' } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'w.client_id');
  const p = { ...scope.params };
  let where = scope.sql;
  if (status === 'open') where += ` AND w.status IN ${OPEN_WITHDRAWAL}`;
  else if (status) { p.status = status; where += ' AND w.status = :status'; }
  return ctx.db.all(`SELECT w.*, pa.name AS platform_account, pa.currency, da.name AS destination, c.name AS client_name,
      CAST(julianday(COALESCE(w.received_on, date('now'))) - julianday(w.requested_on) AS INTEGER) AS days_waiting
    FROM withdrawals w JOIN accounts pa ON pa.id = w.platform_account_id JOIN accounts da ON da.id = w.destination_account_id JOIN clients c ON c.id = w.client_id
    WHERE ${where} ORDER BY w.requested_on DESC, w.created_at DESC LIMIT 500`, p);
}
export const getWithdrawal = (ctx, id) => ctx.db.get(`SELECT w.*, pa.name AS platform_account, pa.currency, da.name AS destination FROM withdrawals w JOIN accounts pa ON pa.id = w.platform_account_id JOIN accounts da ON da.id = w.destination_account_id WHERE w.id = :id`, { id });
