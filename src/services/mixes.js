import { newId, parseJson } from '../db/database.js';
import { AppError, invalid } from '../lib/errors.js';
import { toMinor, fromMinor, roundToMinor, parseOdds } from '../lib/money.js';
import { text, oneOf, id as idField } from '../lib/validate.js';
import * as Mix from '../domain/mix.js';
import { audit, canSeeClient, clientFilter, loadOwned, requireOperator, requireRole } from './common.js';
import { accountMoney, post } from './money.js';

// A Mix is stored as its domain object (major units, JSON) plus the stake
// columns in minor units that balances depend on. Money moves at three
// moments: lock (cash stake leaves), hedge added (hedge stake leaves the hedge
// account), and settlement (payouts arrive).

function present(db, row) {
  const mix = parseJson(row.data, null);
  return { id: row.id, clientId: row.client_id, accountId: row.account_id, title: row.title, status: row.status, version: row.version, settled: Boolean(row.settled), currency: row.currency, accountName: row.account_name,
    mix, values: Mix.values(mix), position: Mix.position(mix), gaps: Mix.timeGaps(mix), active: Mix.activeLeg(mix), settlement: ['completed', 'lost'].includes(mix.status) ? Mix.settlement(mix) : null };
}

const SELECT = 'SELECT m.*, a.currency, a.name AS account_name FROM mixes m JOIN accounts a ON a.id = m.account_id';

export function listMixes(ctx) {
  requireRole(ctx, 'owner', 'admin');
  const scope = clientFilter(ctx, 'm.client_id');
  return ctx.db.all(`${SELECT} WHERE ${scope.sql} ORDER BY m.created_at DESC`, scope.params).map(r => present(ctx.db, r));
}

function load(ctx, mixId) {
  const row = ctx.db.get(`${SELECT} WHERE m.id = :id`, { id: idField(mixId, 'Mix') });
  if (!row) throw new AppError('NOT_FOUND', 'Mix was not found.', 404);
  if (!canSeeClient(ctx, row.client_id)) throw new AppError('NOT_FOUND', 'Mix was not found.', 404);
  return row;
}

function wrap(fn) {
  try { return fn(); } catch (error) { if (error instanceof Mix.MixError) throw invalid(error.message); throw error; }
}

function save(ctx, row, mix, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== row.version) throw new AppError('CONCURRENT_UPDATE', 'This Mix changed after you opened it. Reload it first.', 409);
  ctx.db.run(`UPDATE mixes SET data = :d, status = :s, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id AND version = :v`, { id: row.id, d: JSON.stringify(mix), s: mix.status, v: row.version });
  return present(ctx.db, ctx.db.get(`${SELECT} WHERE m.id = :id`, { id: row.id }));
}

export function createMix(ctx, input) {
  requireOperator(ctx);
  const account = loadOwned(ctx, 'accounts', idField(input.accountId, 'Platform account'), 'Account');
  if (account.kind !== 'platform') throw invalid('A Mix is placed on a platform account.');
  const c = account.currency;
  const stakes = { cash: toMinor(input.cashStake || 0, c, 'Cash stake'), bonus: toMinor(input.bonusStake || 0, c, 'Bonus stake'), free: toMinor(input.freeBetStake || 0, c, 'Free-bet stake') };
  const mix = wrap(() => Mix.createMix({ cashStake: fromMinor(stakes.cash, c), bonusStake: fromMinor(stakes.bonus, c), freeBetStake: fromMinor(stakes.free, c), minimumGapMinutes: Number(input.minimumGapMinutes || 15), recommendedGapMinutes: Number(input.recommendedGapMinutes || 30) }));
  const id = newId();
  ctx.db.run(`INSERT INTO mixes(id, client_id, account_id, title, status, cash_stake, bonus_stake, free_bet_stake, data, created_by) VALUES (:id, :c, :a, :t, 'draft', :cs, :bs, :fs, :d, :u)`,
    { id, c: account.client_id, a: account.id, t: text(input.title, 'Title', { required: true, max: 100 }), cs: stakes.cash, bs: stakes.bonus, fs: stakes.free, d: JSON.stringify(mix), u: ctx.actor.userId });
  audit(ctx, { action: 'mix.created', entityType: 'mix', entityId: id, clientId: account.client_id });
  return present(ctx.db, ctx.db.get(`${SELECT} WHERE m.id = :id`, { id }));
}

export function getMix(ctx, mixId) { requireRole(ctx, 'owner', 'admin'); return present(ctx.db, load(ctx, mixId)); }

export function addLeg(ctx, mixId, input) {
  requireOperator(ctx);
  const row = load(ctx, mixId);
  const mix = wrap(() => Mix.addLeg(parseJson(row.data), { event: text(input.event, 'Event', { required: true, max: 120 }), market: text(input.market, 'Market', { required: true, max: 60 }), selection: text(input.selection, 'Selection', { required: true, max: 60 }), odds: parseOdds(input.odds) / 1000, startsAt: input.startsAt, settlesAt: input.settlesAt }));
  return save(ctx, row, mix, input.expectedVersion);
}

export function removeLeg(ctx, mixId, legId, input = {}) {
  requireOperator(ctx);
  const row = load(ctx, mixId);
  return save(ctx, row, wrap(() => Mix.removeLeg(parseJson(row.data), String(legId))), input.expectedVersion);
}

/** Lock: checks pockets and moves the cash stake out of the account. */
export function lockMix(ctx, mixId, input = {}) {
  requireOperator(ctx);
  const row = load(ctx, mixId);
  const account = ctx.db.get('SELECT * FROM accounts WHERE id = :id', { id: row.account_id });
  const overrideReason = text(input.overrideReason, 'Override reason', { max: 300 }) || '';
  if (overrideReason && ctx.actor.role !== 'owner') throw new AppError('OWNER_APPROVAL_REQUIRED', 'Only the owner can override the timing check.', 403);
  const mix = wrap(() => Mix.lockMix(parseJson(row.data), { overrideReason }));
  const money = accountMoney(ctx.db, account);
  if (row.bonus_stake > money.bonus) throw invalid('Not enough bonus balance for this Mix.');
  if (row.free_bet_stake > money.freeBet) throw invalid('Not enough free-bet balance for this Mix.');
  const saved = save(ctx, row, mix, input.expectedVersion);
  if (row.cash_stake > 0) post(ctx, { clientId: row.client_id, kind: 'stake', from: row.account_id, amountOut: row.cash_stake, sourceType: 'mix', sourceId: row.id, note: `Mix stake · ${row.title}` });
  audit(ctx, { action: 'mix.locked', entityType: 'mix', entityId: row.id, clientId: row.client_id, reason: overrideReason || null });
  return saved;
}

export function addHedge(ctx, mixId, input) {
  requireOperator(ctx);
  const row = load(ctx, mixId);
  const hedgeAccount = loadOwned(ctx, 'accounts', idField(input.accountId, 'Hedge account'), 'Account');
  if (hedgeAccount.kind !== 'platform' || hedgeAccount.client_id !== row.client_id) throw invalid('Hedge from a platform account of the same client.');
  if (hedgeAccount.currency !== row.currency) throw invalid('The hedge account must use the Mix currency.');
  const stakeMinor = toMinor(input.stake, row.currency, 'Hedge stake', { allowZero: false });
  const id = newId();
  const mix = wrap(() => Mix.addHedge(parseJson(row.data), { id, side: oneOf(input.side, ['selection', 'against'], 'Hedge side'), stake: fromMinor(stakeMinor, row.currency), odds: parseOdds(input.odds) / 1000, accountId: hedgeAccount.id }));
  const saved = save(ctx, row, mix, input.expectedVersion);
  post(ctx, { clientId: row.client_id, kind: 'stake', from: hedgeAccount.id, amountOut: stakeMinor, sourceType: 'mix_hedge', sourceId: id, note: `Hedge · ${row.title}` });
  audit(ctx, { action: 'mix.hedged', entityType: 'mix', entityId: row.id, clientId: row.client_id, after: { stake: stakeMinor, side: input.side } });
  return saved;
}

export function suggestHedge(ctx, mixId, odds) {
  requireRole(ctx, 'owner', 'admin');
  const row = load(ctx, mixId);
  return Mix.suggestHedge(parseJson(row.data), parseOdds(odds) / 1000);
}

/** Settle the active leg; pays out settled hedges and, when the Mix ends, the ticket. */
export function settleLeg(ctx, mixId, input) {
  requireOperator(ctx);
  const row = load(ctx, mixId);
  const before = parseJson(row.data);
  const mix = wrap(() => Mix.settleLeg(before, String(input.legId), oneOf(input.result, ['won', 'lost', 'void'], 'Result')));
  const saved = save(ctx, row, mix, input.expectedVersion);
  for (const h of mix.hedges) {
    const was = before.hedges.find(x => x.id === h.id);
    if (was?.status === 'open' && h.status !== 'open' && h.payout > 0) {
      post(ctx, { clientId: row.client_id, kind: 'payout', to: h.accountId, amountIn: roundToMinor(h.payout, row.currency), sourceType: 'mix_hedge', sourceId: h.id, note: `Hedge ${h.status} · ${row.title}` });
    }
  }
  if (['completed', 'lost'].includes(mix.status) && !row.settled) {
    const s = Mix.settlement(mix);
    if (s.ticketReturn > 0) post(ctx, { clientId: row.client_id, kind: 'payout', to: row.account_id, amountIn: roundToMinor(s.ticketReturn, row.currency), sourceType: 'mix', sourceId: row.id, note: `Mix payout · ${row.title}` });
    ctx.db.run('UPDATE mixes SET settled = 1 WHERE id = :id', { id: row.id });
  }
  audit(ctx, { action: 'mix.leg_settled', entityType: 'mix', entityId: row.id, clientId: row.client_id, after: { legId: input.legId, result: input.result, status: mix.status } });
  return present(ctx.db, ctx.db.get(`${SELECT} WHERE m.id = :id`, { id: row.id }));
}
