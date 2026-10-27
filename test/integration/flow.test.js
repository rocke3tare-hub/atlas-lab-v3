import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signedIn, client } from '../helpers.js';

const env = await startTestServer();
test.after(() => env.close());
const owner = await signedIn(env.base, 'owner@atlas.local');
const admin = await signedIn(env.base, 'admin@atlas.local');
const nst = await signedIn(env.base, 'nst@atlas.local');
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body.data; };
const fail = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body.error, code); return r.body; };

const tree = ok(await owner.get('/api/structure'));
const northstar = tree.find(c => c.code === 'NST');
const harbor = tree.find(c => c.code === 'HBR');
const dara = northstar.holders.find(h => h.code === 'NST-DA');
const leyla = northstar.holders.find(h => h.code === 'NST-LK');
const acc = (holder, kind, platform) => holder.accounts.find(a => a.kind === kind && (!platform || a.code.endsWith(platform)));
const daraWallet = acc(dara, 'wallet');
const daraBank = acc(dara, 'bank');
const daraX = acc(dara, 'platform', 'X');
const leylaX = acc(leyla, 'platform', 'X');
const balance = async id => ok(await owner.get('/api/structure')).flatMap(c => c.holders).flatMap(h => h.accounts).find(a => a.id === id);

test('seeded balances are derived from movements', () => {
  assert.equal(daraWallet.balance, 300000 - 90000 - 60000);
  assert.equal(daraX.balance, 90000);
  assert.equal(daraX.freeBet, 2500);
  assert.equal(northstar.unallocated, 1000000 - 900000);
});

test('scope: admins see only assigned clients; shareholders read only their own', async () => {
  const adminClients = ok(await admin.get('/api/clients'));
  assert.deepEqual(adminClients.map(c => c.code), ['NST']);
  fail(await admin.post('/api/holders', { clientId: harbor.id, name: 'X', code: 'HBR-X' }), 403, 'CLIENT_ACCESS_DENIED');
  const mine = ok(await nst.get('/api/structure'));
  assert.deepEqual(mine.map(c => c.code), ['NST']);
  fail(await nst.post('/api/movements', { kind: 'income', toAccountId: daraWallet.id, amount: '1' }), 403, 'PERMISSION_DENIED');
  fail(await admin.post('/api/platforms', { name: 'Z', code: 'Z', currency: 'USD' }), 403, 'PERMISSION_DENIED');
});

test('capital: holder allocations cannot exceed client capital', async () => {
  fail(await owner.post('/api/holders', { clientId: northstar.id, name: 'Too Much', code: 'NST-TM', allocatedCapital: '1000.01' }), 422, 'VALIDATION_ERROR');
  ok(await owner.post('/api/holders', { clientId: northstar.id, name: 'Exact Fit', code: 'NST-EF', allocatedCapital: '1000.00' }), 201);
});

test('money: transfers cannot overdraw; one wallet per holder; reversals keep history', async () => {
  fail(await admin.post('/api/movements', { kind: 'transfer', fromAccountId: daraWallet.id, toAccountId: daraBank.id, amount: '1500.01' }), 422, 'INSUFFICIENT_FUNDS');
  const t = ok(await admin.post('/api/movements', { kind: 'transfer', fromAccountId: daraWallet.id, toAccountId: daraBank.id, amount: '100', fee: '1.50' }), 201);
  assert.equal((await balance(daraWallet.id)).balance, 150000 - 10000 - 150);
  assert.equal((await balance(daraBank.id)).balance, 10000);
  fail(await admin.post('/api/accounts', { holderId: dara.id, kind: 'wallet', code: 'NST-DA-W2', currency: 'USD' }), 409, 'DUPLICATE');
  fail(await admin.post(`/api/movements/${t.id}/reverse`, { reason: 'x' }), 403);
  ok(await owner.post(`/api/movements/${t.id}/reverse`, { reason: 'Entered twice' }), 201);
  fail(await owner.post(`/api/movements/${t.id}/reverse`, { reason: 'again' }), 409, 'ALREADY_REVERSED');
  assert.equal((await balance(daraWallet.id)).balance, 150000);
  assert.throws(() => env.db.run('DELETE FROM movements'), /append-only/);
});

test('exchange: different currencies need explicit amounts on both sides', async () => {
  const irr = ok(await owner.post('/api/accounts', { holderId: leyla.id, kind: 'bank', code: 'NST-LK-IRR', currency: 'IRR', name: 'Leyla rial bank' }), 201);
  ok(await owner.post('/api/movements', { kind: 'opening', toAccountId: irr.id, amount: '50000000' }), 201);
  const leylaWallet = acc(leyla, 'wallet');
  fail(await owner.post('/api/movements', { kind: 'transfer', fromAccountId: irr.id, toAccountId: leylaWallet.id, amount: '1000' }), 422);
  ok(await owner.post('/api/movements', { kind: 'exchange', fromAccountId: irr.id, toAccountId: leylaWallet.id, amount: '42000000', amountReceived: '700.00', fee: '200000' }), 201);
  assert.equal((await balance(irr.id)).balance, 50000000 - 42000000 - 200000);
  assert.equal((await balance(leylaWallet.id)).balance, 150000 - 45000 - 30000 + 70000);
});

let operationId; let eventId;
test('operations: plan, eligibility, reserve, place, settle; turnover follows', async () => {
  const op = ok(await admin.post('/api/operations', { clientId: northstar.id, name: 'Derby night' }), 201);
  operationId = op.id;
  const withEvent = ok(await admin.post(`/api/operations/${op.id}/events`, { name: 'City v United', marketType: 'three_way', startsAt: '2026-11-01T18:00' }), 201);
  eventId = withEvent.events[0].id;
  const planned = ok(await admin.post(`/api/events/${eventId}/plan`, { currency: 'USD', mode: 'balanced', capital: '600', outcomes: [{ type: 'team1_win', odds: '1.90' }, { type: 'draw', odds: '3.20' }, { type: 'team2_win', odds: '3.80' }] }));
  assert.equal(planned.stakesMinor.reduce((a, b) => a + b, 0), 60000);

  const elig = ok(await admin.post(`/api/events/${eventId}/eligibility`, { outcome: 'team1_win', odds: '1.40', stake: '10' }));
  assert.ok(elig.find(e => e.accountId === daraX.id).reasons.some(r => /minimum/.test(r)));

  // Platform X allows one outcome per account per event and one account per outcome.
  ok(await admin.post(`/api/events/${eventId}/bets`, { accountId: daraX.id, outcome: 'team1_win', odds: '1.90', stake: '285.00' }), 201);
  fail(await admin.post(`/api/events/${eventId}/bets`, { accountId: daraX.id, outcome: 'draw', odds: '3.20', stake: '10' }), 422, 'BET_NOT_ELIGIBLE');
  fail(await admin.post(`/api/events/${eventId}/bets`, { accountId: leylaX.id, outcome: 'team1_win', odds: '1.90', stake: '10' }), 422, 'BET_NOT_ELIGIBLE');
  // Reservations reduce availability, so a second big stake cannot overspend (v1 bug).
  fail(await admin.post(`/api/events/${eventId}/bets`, { accountId: daraX.id, outcome: 'team1_win', odds: '1.90', stake: '700' }), 422, 'BET_NOT_ELIGIBLE');
  const leylaY = acc(leyla, 'platform', 'Y');
  let detail = ok(await admin.post(`/api/events/${eventId}/bets`, { accountId: leylaX.id, outcome: 'draw', odds: '3.20', stake: '25', stakeType: 'free_bet' }), 201);
  detail = ok(await admin.post(`/api/events/${eventId}/bets`, { accountId: leylaY.id, outcome: 'team2_win', odds: '3.80', stake: '140.00' }), 201);
  const bets = detail.events[0].bets;
  assert.equal((await balance(daraX.id)).available, 90000 - 28500);
  for (const b of bets) ok(await admin.post(`/api/bets/${b.id}/place`));
  assert.equal((await balance(daraX.id)).balance, 90000 - 28500);
  detail = ok(await admin.post(`/api/events/${eventId}/settle`, { result: 'team1' }));
  const settled = detail.events[0].bets;
  assert.equal(settled.find(b => b.account_id === daraX.id).status, 'won');
  assert.equal(settled.find(b => b.account_id === daraX.id).payout, 54150);
  assert.equal(settled.find(b => b.stake_type === 'free_bet').payout, 0);
  assert.equal((await balance(daraX.id)).balance, 90000 - 28500 + 54150);
  const turnover = (await balance(daraX.id)).turnover;
  assert.equal(turnover.completed, 28500);
  assert.equal(turnover.required, 90000);
  fail(await admin.post(`/api/events/${eventId}/settle`, { result: 'draw' }), 409, 'ALREADY_SETTLED');
});

test('withdrawals: hold balance while pending; shortfall booked as a fee', async () => {
  fail(await admin.post('/api/withdrawals', { platformAccountId: daraX.id, destinationAccountId: daraWallet.id, amount: '5000' }), 422, 'INSUFFICIENT_FUNDS');
  const w = ok(await admin.post('/api/withdrawals', { platformAccountId: daraX.id, destinationAccountId: daraWallet.id, amount: '500.00', requestedOn: '2026-11-02' }), 201);
  assert.equal((await balance(daraX.id)).available, 115650 - 50000);
  const tasks = ok(await admin.get('/api/tasks'));
  assert.ok(tasks.some(t => t.source_id === w.id));
  fail(await admin.patch(`/api/withdrawals/${w.id}`, { status: 'delayed' }), 422, 'VALIDATION_ERROR');
  ok(await admin.patch(`/api/withdrawals/${w.id}`, { status: 'delayed', reason: 'Platform review' }));
  ok(await admin.patch(`/api/withdrawals/${w.id}`, { status: 'received', receivedAmount: '495.00', receivedOn: '2026-11-04' }));
  assert.equal((await balance(daraX.id)).balance, 115650 - 50000);
  assert.equal((await balance(daraWallet.id)).balance, 150000 + 49500);
  assert.ok(!ok(await admin.get('/api/tasks')).some(t => t.source_id === w.id));
  fail(await admin.patch(`/api/withdrawals/${w.id}`, { status: 'cancelled', reason: 'x' }), 422, 'INVALID_STATUS_TRANSITION');
});

test('profit & loss and shareholder distribution add up', async () => {
  const dash = ok(await owner.get('/api/dashboard'));
  const usd = dash.profitAndLoss.find(r => r.currency === 'USD');
  // Payout 541.50 - stakes (285 + 140) - transfer fee 1.50 - withdrawal shortfall 5.00
  assert.equal(usd.net, 54150 - 28500 - 14000 - 150 - 500);
  const dist = ok(await owner.get('/api/distribution'));
  assert.equal(dist.rows.reduce((s, r) => s + r.gross, 0) + dist.roundingRemainder, dist.profit);
  const nstView = ok(await nst.get('/api/distribution'));
  assert.equal(nstView.rows.length, 1);
  assert.equal(nstView.profit, undefined);
});

test('shareholder payments move money only when completed by the owner', async () => {
  const sh = ok(await owner.get('/api/clients')).find(c => c.code === 'NST');
  const id = ok(await owner.post('/api/payments', { shareholderId: sh.shareholder_id, amount: '20', fromAccountId: daraWallet.id }), 201).id;
  const before = (await balance(daraWallet.id)).balance;
  ok(await owner.patch(`/api/payments/${id}`, { status: 'completed' }));
  assert.equal((await balance(daraWallet.id)).balance, before - 2000);
  fail(await owner.patch(`/api/payments/${id}`, { status: 'failed' }), 409, 'ALREADY_DECIDED');
  const dash = ok(await owner.get('/api/dashboard'));
  assert.equal(dash.profitAndLoss.find(r => r.currency === 'USD').net, 54150 - 28500 - 14000 - 150 - 500, 'shareholder payouts are not a loss');
});

test('mix: lock moves the cash stake; completion pays out; void leg handled', async () => {
  const mix = ok(await admin.post('/api/mixes', { accountId: daraX.id, title: 'Weekend double', cashStake: '10', freeBetStake: '0' }), 201);
  let m = ok(await admin.post(`/api/mixes/${mix.id}/legs`, { event: 'A v B', market: '1X2', selection: 'A', odds: '2.00', startsAt: '2026-11-08T12:00', settlesAt: '2026-11-08T14:00' }));
  m = ok(await admin.post(`/api/mixes/${mix.id}/legs`, { event: 'C v D', market: '1X2', selection: 'C', odds: '1.50', startsAt: '2026-11-08T15:00', settlesAt: '2026-11-08T17:00' }));
  const before = (await balance(daraX.id)).balance;
  m = ok(await admin.post(`/api/mixes/${mix.id}/lock`, {}));
  assert.equal((await balance(daraX.id)).balance, before - 1000);
  m = ok(await admin.post(`/api/mixes/${mix.id}/settle`, { legId: m.active.id, result: 'void' }));
  m = ok(await admin.post(`/api/mixes/${mix.id}/settle`, { legId: m.active.id, result: 'won' }));
  assert.equal(m.status, 'completed');
  assert.equal((await balance(daraX.id)).balance, before - 1000 + 1500);
});

test('exports and audit', async () => {
  const x = await owner.get('/api/export?format=xlsx');
  assert.equal(x.status, 200);
  assert.equal(x.body.subarray(0, 2).toString(), 'PK');
  const audit = ok(await owner.get('/api/audit'));
  assert.ok(audit.some(a => a.action === 'event.settled'));
  fail(await admin.get('/api/audit'), 403);
  fail(await client(env.base).get('/api/dashboard'), 401, 'AUTHENTICATION_REQUIRED');
});

test('closing an operation requires all bets settled', async () => {
  ok(await admin.patch(`/api/operations/${operationId}`, { status: 'closed' }));
  fail(await admin.post(`/api/operations/${operationId}/events`, { name: 'Late', marketType: 'two_way' }), 422);
  void eventId;
});
