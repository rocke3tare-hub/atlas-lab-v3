import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, simplex } from '../../src/domain/calculator.js';
import * as Mix from '../../src/domain/mix.js';
import { distribute, roundDiv } from '../../src/domain/profit.js';
import { eligibility, turnover, DEFAULT_RULE } from '../../src/domain/rules.js';
import { toMinor, parseOdds, parsePercent, roundToMinor } from '../../src/lib/money.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const code = c => e => e.code === c;

test('money: currency decimals are enforced, never silently rounded', () => {
  assert.equal(toMinor('1,250.50', 'USD'), 125050);
  assert.equal(toMinor('1500000', 'IRR'), 1500000);
  assert.throws(() => toMinor('1.005', 'USD'), code('VALIDATION_ERROR'));
  assert.throws(() => toMinor('1.5', 'IRR'), code('VALIDATION_ERROR'));
  assert.throws(() => toMinor('-1', 'USD'), code('VALIDATION_ERROR'));
  assert.equal(toMinor('-1', 'USD', 'x', { allowNegative: true }), -100);
  assert.equal(parseOdds('1.905'), 1905);
  assert.throws(() => parseOdds('1.00'), code('VALIDATION_ERROR'));
  assert.equal(parsePercent('12.5'), 1250);
  assert.equal(roundToMinor(0.005, 'USD'), 1);
});

test('simplex: solves a small max problem exactly', () => {
  // max x + y s.t. x <= 3, y <= 2, x + y <= 4
  const r = simplex([[1, 0], [0, 1], [1, 1]], [3, 2, 4], [1, 1]);
  close(r.value, 4);
});

test('calculator: balanced three-way stakes equalise every result', () => {
  const r = plan({ marketType: 'three_way', mode: 'balanced', capital: 1000, increment: 0.01, outcomes: [{ type: 'team1_win', odds: 1.9 }, { type: 'draw', odds: 3.2 }, { type: 'team2_win', odds: 3.8 }] });
  close(r.totalStake, 1000, 1e-6);
  assert.ok(r.bestProfit - r.worstProfit < 0.05);
  close(r.bookPercent, (1 / 1.9 + 1 / 3.2 + 1 / 3.8) * 100, 1e-9);
  assert.equal(r.arbitrage, false);
});

test('calculator: arbitrage is detected and guaranteed', () => {
  const r = plan({ marketType: 'two_way', mode: 'balanced', capital: 100, increment: 0.01, outcomes: [{ type: 'team1_win', odds: 2.1 }, { type: 'team2_win', odds: 2.1 }] });
  assert.deepEqual(r.stakes, [50, 50]);
  close(r.worstProfit, 5);
  assert.equal(r.arbitrage, true);
});

test('calculator: draw-no-bet uses the exact max-min optimum (beats v1 heuristic)', () => {
  const r = plan({ marketType: 'three_way', mode: 'balanced', capital: 1000, increment: 1, outcomes: [{ type: 'team1_dnb', odds: 1.2 }, { type: 'draw', odds: 3.9 }, { type: 'team2_win', odds: 6.85 }] });
  // Exact optimum equalises all three results: a(1 + 0.2/3.9 + 1.2/6.85) = 1000.
  const a = 1000 / (1 + 0.2 / 3.9 + 1.2 / 6.85);
  const optimum = 1.2 * a - 1000; // ≈ -21.58
  assert.ok(r.worstProfit <= optimum + 1e-6, 'cannot beat the LP optimum');
  assert.ok(r.worstProfit >= optimum - 1.2, `rounding to whole units costs at most ~1: ${r.worstProfit}`);
  assert.equal(r.stakes.reduce((x, y) => x + y, 0), 1000);
});

test('calculator: locks, maximums, uncovered results and target mode', () => {
  const locked = plan({ marketType: 'three_way', mode: 'balanced', capital: 1000, increment: 0.01, outcomes: [{ type: 'team1_win', odds: 1.9, locked: true, stake: 600 }, { type: 'draw', odds: 3.2 }, { type: 'team2_win', odds: 3.8 }] });
  assert.equal(locked.stakes[0], 600);
  close(locked.totalStake, 1000);
  const capped = plan({ marketType: 'two_way', mode: 'balanced', capital: 100, increment: 0.01, outcomes: [{ type: 'team1_win', odds: 2, max: 10 }, { type: 'team2_win', odds: 2 }] });
  assert.ok(capped.warnings.some(w => /maximum stake/.test(w)));
  const manual = plan({ marketType: 'three_way', mode: 'manual', outcomes: [{ type: 'team1_win', odds: 1.9, stake: 500 }, { type: 'team2_win', odds: 3.8, stake: 250 }] });
  assert.ok(manual.warnings.some(w => /Draw/.test(w)));
  const target = plan({ marketType: 'three_way', mode: 'target', targetReturn: 1000, increment: 0.01, outcomes: [{ type: 'team1_win', odds: 1.9 }, { type: 'draw', odds: 3.2 }, { type: 'team2_win', odds: 3.8 }] });
  assert.ok(target.scenarios.every(s => s.grossReturn >= 1000 - 1e-9));
  assert.throws(() => plan({ marketType: 'two_way', mode: 'balanced', capital: 10, outcomes: [{ type: 'draw', odds: 3 }] }), /three-outcome/);
});

test('mix: v1 regression scenario (free-bet deduction once, values, order)', () => {
  let m = Mix.createMix({ cashStake: 120, bonusStake: 80, freeBetStake: 100 });
  [['Leg 1', 1.5, '2026-07-28T18:00'], ['Leg 2', 2, '2026-07-28T18:35'], ['Leg 3', 1.8, '2026-07-28T19:10']].forEach(([event, odds, settlesAt]) => {
    m = Mix.addLeg(m, { event, market: 'Match Winner', selection: 'Selected', odds, startsAt: '2026-07-28T17:00', settlesAt });
  });
  m = Mix.lockMix(m);
  close(Mix.combinedOdds(m), 5.4);
  close(Mix.values(m).freeBetProvisional, 540);
  assert.equal(Mix.activeLeg(m).event, 'Leg 1');
  m = Mix.settleLeg(m, Mix.activeLeg(m).id, 'won');
  const v = Mix.values(m);
  close(v.freeBetTrue, 440); close(v.cashPotential, 648); close(v.bonusPotential, 432); close(v.truePotential, 1520);
  assert.equal(m.freeBetDeducted, true);
  assert.equal(Mix.activeLeg(m).event, 'Leg 2');
});

test('mix: a void leg is skipped and its odds removed (v1 bug)', () => {
  let m = Mix.createMix({ cashStake: 10 });
  m = Mix.addLeg(m, { event: 'A', market: 'M', selection: 'S', odds: 2, startsAt: '2026-01-01T10:00', settlesAt: '2026-01-01T12:00' });
  m = Mix.addLeg(m, { event: 'B', market: 'M', selection: 'S', odds: 3, startsAt: '2026-01-01T13:00', settlesAt: '2026-01-01T15:00' });
  m = Mix.lockMix(m);
  m = Mix.settleLeg(m, Mix.activeLeg(m).id, 'void');
  assert.equal(Mix.activeLeg(m).event, 'B');
  close(Mix.combinedOdds(m), 3);
  m = Mix.settleLeg(m, Mix.activeLeg(m).id, 'won');
  assert.equal(m.status, 'completed');
  close(Mix.settlement(m).ticketReturn, 30);
});

test('mix: lost leg closes, timing gaps, hedges and suggestions', () => {
  let m = Mix.createMix({ freeBetStake: 100, minimumGapMinutes: 15, recommendedGapMinutes: 30 });
  m = Mix.addLeg(m, { event: 'A', market: 'M', selection: 'S', odds: 1.5, startsAt: '2026-07-28T17:00', settlesAt: '2026-07-28T18:00' });
  m = Mix.addLeg(m, { event: 'B', market: 'M', selection: 'S', odds: 2, startsAt: '2026-07-28T17:00', settlesAt: '2026-07-28T18:10' });
  assert.equal(Mix.timeGaps(m)[0].status, 'insufficient');
  assert.throws(() => Mix.lockMix(m), /override/);
  m = Mix.lockMix(m, { overrideReason: 'Owner accepts the risk' });
  m = Mix.addHedge(m, { side: 'against', stake: 20, odds: 3 });
  const s = Mix.suggestHedge(m, 2.5);
  assert.equal(s.committed, undefined);
  assert.equal(m.hedges.length, 1);
  m = Mix.settleLeg(m, Mix.activeLeg(m).id, 'lost');
  assert.equal(m.status, 'lost');
  assert.equal(m.hedges[0].status, 'won');
  close(Mix.settlement(m).hedgeReturn, 60);
  close(Mix.settlement(m).ticketReturn, 0);
});

test('profit: shares add up exactly; capital includes top-ups on both sides (v1 bug)', () => {
  const r = distribute({ profit: 100001, shareholders: [
    { id: 'a', clientId: 'A', status: 'active', capital: 1000000 + 200000, profitShareBp: 4000, paid: 1000 },
    { id: 'b', clientId: 'B', status: 'active', capital: 400000, profitShareBp: 5000, paid: 0 },
    { id: 'c', clientId: 'C', status: 'paused', capital: 999999, profitShareBp: 5000, paid: 0 }
  ] });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.reduce((s, x) => s + x.gross, 0) + r.roundingRemainder, 100001);
  for (const row of r.rows) assert.equal(row.payable + row.retained, row.gross);
  assert.equal(r.rows[0].gross, 75001);
  assert.equal(r.rows[0].unpaid, r.rows[0].payable - 1000);
  assert.equal(roundDiv(-5, 2), -3);
});

test('rules: eligibility blocks overspend, odds and outcome limits; turnover derives', () => {
  const rule = { ...DEFAULT_RULE, minOdds: 1500, maxStake: 50000 };
  const account = { id: 'x', platformId: 'p', status: 'active', kycStatus: 'verified' };
  const ok = eligibility({ account, rule, available: 10000, reservations: [], eventKey: 'e', outcome: 'team1_win', stake: 5000, odds: 1900 });
  assert.equal(ok.status, 'ok');
  const over = eligibility({ account, rule, available: 4000, reservations: [], eventKey: 'e', outcome: 'team1_win', stake: 5000, odds: 1900 });
  assert.equal(over.status, 'blocked');
  const lowOdds = eligibility({ account, rule, available: 10000, reservations: [], eventKey: 'e', outcome: 'team1_win', stake: 100, odds: 1400 });
  assert.match(lowOdds.reasons.join(' '), /minimum/);
  const second = eligibility({ account, rule, available: 10000, reservations: [{ accountId: 'x', eventKey: 'e', outcome: 'draw', platformId: 'p' }], eventKey: 'e', outcome: 'team1_win', stake: 100, odds: 2000 });
  assert.match(second.reasons.join(' '), /outcome\(s\) per event/);
  const t = turnover({ deposits: 10000, bonusCredited: 5000, eligibleStakes: 12000 }, { ...rule, turnoverBp: 20000, turnoverBase: 'deposit_plus_bonus' });
  assert.deepEqual([t.required, t.remaining, t.percent], [30000, 18000, 40]);
});
