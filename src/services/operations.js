import { newId, parseJson } from '../db/database.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { toMinor, parseOdds, roundToMinor, fromMinor, CURRENCIES } from '../lib/money.js';
import { text, oneOf, id as idField } from '../lib/validate.js';
import { plan, OUTCOME_TYPES, MARKET_TYPES } from '../domain/calculator.js';
import { eligibility } from '../domain/rules.js';
import { audit, clientFilter, loadOwned, requireClient, requireOperator, requireRole, closeTasks } from './common.js';
import { accountMoney, post } from './money.js';
import { ruleFor } from './structure.js';

// An operation groups events; each event has a calculator plan and bets.
// Bet lifecycle: reserved (holds balance) -> placed (stake leaves the
// platform balance) -> won | lost | void (payout returns). cancelled frees it.

export function listOperations(ctx) {
  requireRole(ctx, 'owner', 'admin');
  const scope = clientFilter(ctx, 'o.client_id');
  return ctx.db.all(`SELECT o.*, c.name AS client_name,
      (SELECT count(*) FROM events e WHERE e.operation_id = o.id) AS events,
      (SELECT count(*) FROM bets b JOIN events e ON e.id = b.event_id WHERE e.operation_id = o.id AND b.status IN ('reserved','placed')) AS open_bets
    FROM operations o JOIN clients c ON c.id = o.client_id WHERE ${scope.sql} ORDER BY o.created_at DESC`, scope.params);
}

export function createOperation(ctx, input) {
  requireOperator(ctx);
  const clientId = idField(input.clientId, 'Client');
  requireClient(ctx, clientId);
  const id = newId();
  ctx.db.run('INSERT INTO operations(id, client_id, name, notes, created_by) VALUES (:id, :c, :n, :notes, :u)', { id, c: clientId, n: text(input.name, 'Name', { required: true, max: 100 }), notes: text(input.notes, 'Notes', { max: 500 }), u: ctx.actor.userId });
  audit(ctx, { action: 'operation.created', entityType: 'operation', entityId: id, clientId });
  return getOperation(ctx, id);
}

export function setOperationStatus(ctx, operationId, status) {
  requireOperator(ctx);
  const op = loadOwned(ctx, 'operations', idField(operationId), 'Operation');
  const next = oneOf(status, ['planning', 'live', 'closed'], 'Status');
  if (next === 'closed' && ctx.db.get(`SELECT 1 FROM bets b JOIN events e ON e.id = b.event_id WHERE e.operation_id = :o AND b.status IN ('reserved','placed')`, { o: op.id })) {
    throw invalid('Settle or cancel every open bet before closing the operation.');
  }
  ctx.db.run('UPDATE operations SET status = :s WHERE id = :id', { id: op.id, s: next });
  audit(ctx, { action: `operation.${next}`, entityType: 'operation', entityId: op.id, clientId: op.client_id, before: { status: op.status } });
  return getOperation(ctx, op.id);
}

export function getOperation(ctx, operationId) {
  requireRole(ctx, 'owner', 'admin');
  const op = loadOwned(ctx, 'operations', idField(operationId), 'Operation');
  const events = ctx.db.all('SELECT * FROM events WHERE operation_id = :o ORDER BY COALESCE(starts_at, created_at)', { o: op.id });
  const bets = ctx.db.all(`SELECT b.*, a.name AS account_name, a.currency, p.name AS platform_name FROM bets b JOIN accounts a ON a.id = b.account_id JOIN platforms p ON p.id = a.platform_id JOIN events e ON e.id = b.event_id WHERE e.operation_id = :o ORDER BY b.created_at`, { o: op.id });
  return {
    ...op,
    events: events.map(e => {
      const eventBets = bets.filter(b => b.event_id === e.id);
      return { ...e, plan: parseJson(e.plan, null), bets: eventBets, exposure: exposure(e, eventBets) };
    })
  };
}

/** What each match result would return across the event's live bets, per currency. */
function exposure(event, bets) {
  const live = bets.filter(b => ['reserved', 'placed', 'won', 'lost', 'void'].includes(b.status));
  const scenarios = MARKET_TYPES[event.market_type].scenarios;
  const byCurrency = {};
  for (const b of live) {
    const row = (byCurrency[b.currency] ??= { stake: 0, returns: Object.fromEntries(scenarios.map(s => [s, 0])) });
    if (b.stake_type !== 'free_bet') row.stake += b.stake;
    for (const s of scenarios) row.returns[s] += payoutFor(b, s);
  }
  return Object.entries(byCurrency).map(([currency, r]) => ({ currency, stake: r.stake, scenarios: scenarios.map(s => ({ scenario: s, grossReturn: r.returns[s], profit: r.returns[s] - r.stake })) }));
}

/** Integer payout of one bet for a match result (minor units). */
export function payoutFor(bet, result) {
  if (result === 'void') return bet.stake_type === 'free_bet' ? 0 : bet.stake;
  const factor = OUTCOME_TYPES[bet.outcome].pays(bet.odds / 1000)[result] || 0;
  if (factor === 0) return 0;
  if (factor === 1) return bet.stake_type === 'free_bet' ? 0 : bet.stake; // stake returned (DNB draw)
  const gross = Math.round((bet.stake * Math.round(factor * 1000)) / 1000);
  return bet.stake_type === 'free_bet' ? gross - bet.stake : gross;
}

export function addEvent(ctx, operationId, input) {
  requireOperator(ctx);
  const op = loadOwned(ctx, 'operations', idField(operationId), 'Operation');
  if (op.status === 'closed') throw invalid('This operation is closed.');
  const id = newId();
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw invalid('Start time is not a valid date and time.');
  ctx.db.run('INSERT INTO events(id, operation_id, name, market_type, starts_at) VALUES (:id, :o, :n, :m, :s)', { id, o: op.id, n: text(input.name, 'Event name', { required: true, max: 120 }), m: oneOf(input.marketType, Object.keys(MARKET_TYPES), 'Market'), s: startsAt?.toISOString() ?? null });
  audit(ctx, { action: 'event.created', entityType: 'event', entityId: id, clientId: op.client_id });
  return getOperation(ctx, op.id);
}

function loadEvent(ctx, eventId) {
  const event = ctx.db.get('SELECT * FROM events WHERE id = :id', { id: idField(eventId, 'Event') });
  if (!event) throw notFound('Event');
  const op = loadOwned(ctx, 'operations', event.operation_id, 'Event');
  return { event, op };
}

/** Run the stake planner and store the plan on the event (planning only; moves no money). */
export function planEvent(ctx, eventId, input) {
  requireOperator(ctx);
  const { event, op } = loadEvent(ctx, eventId);
  const currency = String(input.currency || 'USD').toUpperCase();
  if (!CURRENCIES[currency]) throw invalid('Unsupported currency.');
  const step = 1 / 10 ** CURRENCIES[currency].decimals;
  const outcomes = (Array.isArray(input.outcomes) ? input.outcomes : []).map((o, i) => {
    if (!OUTCOME_TYPES[o.type]) throw invalid(`Outcome ${i + 1} has an unknown type.`);
    const amount = (v, f) => (v === '' || v == null ? undefined : fromMinor(toMinor(v, currency, f), currency));
    return { type: o.type, odds: parseOdds(o.odds, `Odds for outcome ${i + 1}`) / 1000, stake: amount(o.stake, 'Stake'), locked: Boolean(o.locked), min: amount(o.min, 'Minimum stake'), max: amount(o.max, 'Maximum stake') };
  });
  if (outcomes.length > 8) throw invalid('At most eight outcomes per event.');
  let result;
  try {
    result = plan({ marketType: event.market_type, mode: oneOf(input.mode || 'balanced', ['balanced', 'target', 'manual'], 'Mode'), capital: input.capital === '' || input.capital == null ? 0 : fromMinor(toMinor(input.capital, currency, 'Capital'), currency), targetReturn: input.targetReturn ? fromMinor(toMinor(input.targetReturn, currency, 'Target return'), currency) : 0, increment: Math.max(step, Number(input.increment) || step), outcomes });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid(error.message);
  }
  const stored = { currency, mode: input.mode || 'balanced', input: outcomes, ...result, stakesMinor: result.stakes.map(s => roundToMinor(s, currency)), at: new Date().toISOString() };
  ctx.db.run('UPDATE events SET plan = :p WHERE id = :id', { id: event.id, p: JSON.stringify(stored) });
  audit(ctx, { action: 'event.planned', entityType: 'event', entityId: event.id, clientId: op.client_id, after: { mode: stored.mode, totalStake: result.totalStake, worst: result.worstProfit } });
  return stored;
}

/** Reservations on open bets, for eligibility (any client: platform rules are per platform). */
function openReservations(db) {
  return db.all(`SELECT b.account_id AS accountId, b.event_id AS eventKey, b.outcome, b.stake, a.platform_id AS platformId FROM bets b JOIN accounts a ON a.id = b.account_id WHERE b.status IN ('reserved','placed')`);
}

/** Check (without saving) which accounts of the client can take a stake. */
export function checkEligibility(ctx, eventId, input) {
  requireOperator(ctx);
  const { event, op } = loadEvent(ctx, eventId);
  const outcome = oneOf(input.outcome, Object.keys(OUTCOME_TYPES), 'Outcome');
  const odds = parseOdds(input.odds);
  const accounts = ctx.db.all(`SELECT a.*, h.name AS holder_name, p.name AS platform_name FROM accounts a JOIN holders h ON h.id = a.holder_id JOIN platforms p ON p.id = a.platform_id WHERE a.client_id = :c AND a.kind = 'platform' AND p.status = 'active' ORDER BY p.name, h.name`, { c: op.client_id });
  const reservations = openReservations(ctx.db);
  return accounts.map(a => {
    const stake = input.stake ? toMinor(input.stake, a.currency, 'Stake') : 1;
    const money = accountMoney(ctx.db, a);
    const stakeType = input.stakeType || 'cash';
    const available = stakeType === 'bonus' ? money.bonus : stakeType === 'free_bet' ? money.freeBet : money.available;
    const check = eligibility({ account: { id: a.id, platformId: a.platform_id, status: a.status, kycStatus: a.kyc_status }, rule: ruleFor(ctx.db, a.platform_id), available, reservations, eventKey: event.id, outcome, stake, odds });
    return { accountId: a.id, name: a.name, holder: a.holder_name, platform: a.platform_name, currency: a.currency, available, ...check };
  });
}

export function reserveBet(ctx, eventId, input) {
  requireOperator(ctx);
  const { event, op } = loadEvent(ctx, eventId);
  if (op.status === 'closed') throw invalid('This operation is closed.');
  if (event.result) throw invalid('This event is already settled.');
  const account = loadOwned(ctx, 'accounts', idField(input.accountId, 'Account'), 'Account');
  if (account.kind !== 'platform' || account.client_id !== op.client_id) throw invalid('Choose a platform account of this operation’s client.');
  const outcome = oneOf(input.outcome, Object.keys(OUTCOME_TYPES), 'Outcome');
  if (OUTCOME_TYPES[outcome].threeWayOnly && event.market_type === 'two_way') throw invalid('That outcome needs a three-outcome market.');
  const odds = parseOdds(input.odds);
  const stake = toMinor(input.stake, account.currency, 'Stake', { allowZero: false });
  const stakeType = oneOf(input.stakeType || 'cash', ['cash', 'bonus', 'free_bet'], 'Stake type');
  const rule = ruleFor(ctx.db, account.platform_id);
  const money = accountMoney(ctx.db, account);
  const available = stakeType === 'bonus' ? money.bonus : stakeType === 'free_bet' ? money.freeBet : money.available;
  const check = eligibility({ account: { id: account.id, platformId: account.platform_id, status: account.status, kycStatus: account.kyc_status }, rule, available, reservations: openReservations(ctx.db), eventKey: event.id, outcome, stake, odds });
  const overrideNote = text(input.overrideNote, 'Override note', { max: 300 });
  if (check.status === 'blocked') throw new AppError('BET_NOT_ELIGIBLE', check.reasons.join(' '), 422, { reasons: check.reasons });
  let approvedBy = null;
  if (check.status === 'review') {
    if (ctx.actor.role !== 'owner') throw new AppError('OWNER_APPROVAL_REQUIRED', 'This platform requires the owner to approve each stake.', 403);
    if (!overrideNote) throw invalid('Add an approval note.', { field: 'overrideNote' });
    approvedBy = ctx.actor.userId;
  }
  const id = newId();
  ctx.db.run(`INSERT INTO bets(id, event_id, account_id, outcome, odds, stake, stake_type, rule_id, approval_note, approved_by, created_by) VALUES (:id, :e, :a, :o, :odds, :s, :t, :r, :n, :ab, :u)`,
    { id, e: event.id, a: account.id, o: outcome, odds, s: stake, t: stakeType, r: rule.id, n: overrideNote, ab: approvedBy, u: ctx.actor.userId });
  audit(ctx, { action: 'bet.reserved', entityType: 'bet', entityId: id, clientId: op.client_id, after: { account: account.name, outcome, odds, stake, stakeType } });
  return getOperation(ctx, op.id);
}

function loadBet(ctx, betId) {
  const bet = ctx.db.get('SELECT * FROM bets WHERE id = :id', { id: idField(betId, 'Bet') });
  if (!bet) throw notFound('Bet');
  const { event, op } = loadEvent(ctx, bet.event_id);
  return { bet, event, op };
}

/** reserved -> placed: the stake leaves the platform cash balance (cash stakes only). */
export function placeBet(ctx, betId) {
  requireOperator(ctx);
  const { bet, op } = loadBet(ctx, betId);
  if (bet.status !== 'reserved') throw invalid(`Only reserved bets can be placed; this one is ${bet.status}.`);
  ctx.db.run(`UPDATE bets SET status = 'placed', placed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: bet.id });
  if (bet.stake_type === 'cash') post(ctx, { clientId: op.client_id, kind: 'stake', from: bet.account_id, amountOut: bet.stake, sourceType: 'bet', sourceId: bet.id, note: `Stake · ${OUTCOME_TYPES[bet.outcome].label}`, allowOverdraft: true });
  audit(ctx, { action: 'bet.placed', entityType: 'bet', entityId: bet.id, clientId: op.client_id });
  return getOperation(ctx, op.id);
}

export function cancelBet(ctx, betId, input) {
  requireOperator(ctx);
  const { bet, op } = loadBet(ctx, betId);
  if (bet.status !== 'reserved') throw invalid('Only reserved (not yet placed) bets can be cancelled. Placed bets settle with the event result.');
  ctx.db.run(`UPDATE bets SET status = 'cancelled' WHERE id = :id`, { id: bet.id });
  audit(ctx, { action: 'bet.cancelled', entityType: 'bet', entityId: bet.id, clientId: op.client_id, reason: text(input?.reason, 'Reason', { max: 300 }) });
  return getOperation(ctx, op.id);
}

/**
 * Enter the match result: every placed bet settles and its payout is posted to
 * the platform account. Reserved-but-never-placed bets are cancelled.
 */
export function settleEvent(ctx, eventId, input) {
  requireOperator(ctx);
  const { event, op } = loadEvent(ctx, eventId);
  if (event.result) throw new AppError('ALREADY_SETTLED', 'This event is already settled.', 409);
  const scenarios = MARKET_TYPES[event.market_type].scenarios;
  const result = oneOf(input.result, [...scenarios, 'void'], 'Result');
  const bets = ctx.db.all(`SELECT * FROM bets WHERE event_id = :e AND status IN ('reserved','placed')`, { e: event.id });
  for (const bet of bets) {
    if (bet.status === 'reserved') { ctx.db.run(`UPDATE bets SET status = 'cancelled' WHERE id = :id`, { id: bet.id }); continue; }
    const payout = payoutFor(bet, result);
    const factor = result === 'void' ? 1 : (OUTCOME_TYPES[bet.outcome].pays(bet.odds / 1000)[result] || 0);
    const status = factor === 1 ? 'void' : factor === 0 ? 'lost' : 'won';
    ctx.db.run(`UPDATE bets SET status = :s, payout = :p, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: bet.id, s: status, p: payout });
    if (payout > 0) post(ctx, { clientId: op.client_id, kind: 'payout', to: bet.account_id, amountIn: payout, sourceType: 'bet', sourceId: bet.id, note: `${status === 'void' ? 'Refund' : 'Payout'} · ${event.name}` });
  }
  ctx.db.run(`UPDATE events SET result = :r, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: event.id, r: result });
  closeTasks(ctx, 'event', event.id);
  audit(ctx, { action: 'event.settled', entityType: 'event', entityId: event.id, clientId: op.client_id, after: { result, bets: bets.length } });
  return getOperation(ctx, op.id);
}

