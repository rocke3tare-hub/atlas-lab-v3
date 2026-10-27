// Sequential accumulator ("Mix") with cash, bonus and free-bet portions,
// hedges per leg, and the one-time free-bet deduction (a free bet pays
// winnings only, so stake x (odds - 1)). Pure functions: every operation
// returns a new mix object and never mutates its input.
//
// Fixes over v1: a "Void" leg is now treated as void (v1 left it as the active
// leg forever and kept its odds in the price); voided legs settle at odds 1.

const r6 = v => Math.round(v * 1e6) / 1e6;
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const clone = v => structuredClone(v);
const VOID_STATES = new Set(['void', 'cancelled']);
const CLOSED = new Set(['lost', 'completed', 'cancelled']);

export class MixError extends Error {}

export function createMix({ cashStake = 0, bonusStake = 0, freeBetStake = 0, minimumGapMinutes = 15, recommendedGapMinutes = 30, targetReturn = 0 } = {}) {
  for (const [label, v] of [['Cash stake', cashStake], ['Bonus stake', bonusStake], ['Free-bet stake', freeBetStake]]) {
    if (!(Number(v) >= 0)) throw new MixError(`${label} cannot be negative.`);
  }
  return { status: 'draft', cashStake: Number(cashStake), bonusStake: Number(bonusStake), freeBetStake: Number(freeBetStake), minimumGapMinutes: Number(minimumGapMinutes), recommendedGapMinutes: Number(recommendedGapMinutes), targetReturn: Number(targetReturn), legs: [], hedges: [], freeBetDeducted: false, history: [] };
}

const log = (mix, action, detail = {}) => ({ ...mix, history: [...mix.history, { action, at: new Date().toISOString(), ...detail }] });

export function orderedLegs(mix) {
  return mix.legs.slice().sort((a, b) => String(a.settlesAt).localeCompare(String(b.settlesAt)) || a.seq - b.seq);
}

export function combinedOdds(mix) {
  const legs = mix.legs.filter(l => !VOID_STATES.has(l.status));
  return r6(legs.reduce((p, l) => p * l.odds, 1));
}

export function activeLeg(mix) {
  if (CLOSED.has(mix.status) || mix.status === 'draft') return null;
  return orderedLegs(mix).find(l => l.status === 'pending') || null;
}

export function addLeg(mix, leg) {
  if (mix.status !== 'draft') throw new MixError('Legs can only be added before the Mix is locked.');
  const odds = Number(leg.odds);
  if (!leg.event || !leg.market || !leg.selection) throw new MixError('A leg needs an event, a market and a selection.');
  if (!(odds > 1)) throw new MixError('Leg odds must be above 1.');
  if (!leg.startsAt || !leg.settlesAt || Number.isNaN(Date.parse(leg.settlesAt)) || Number.isNaN(Date.parse(leg.startsAt))) throw new MixError('A leg needs valid start and settlement times.');
  if (Date.parse(leg.settlesAt) < Date.parse(leg.startsAt)) throw new MixError('A leg cannot settle before it starts.');
  const id = leg.id || `leg-${mix.legs.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  const next = clone(mix);
  next.legs.push({ id, seq: mix.legs.length + 1, event: String(leg.event), market: String(leg.market), selection: String(leg.selection), odds, startsAt: leg.startsAt, settlesAt: leg.settlesAt, status: 'pending' });
  return log(next, 'leg_added', { legId: id });
}

export function removeLeg(mix, legId) {
  if (mix.status !== 'draft') throw new MixError('Locked legs cannot be removed.');
  const next = clone(mix);
  next.legs = next.legs.filter(l => l.id !== legId);
  return log(next, 'leg_removed', { legId });
}

/** Gap between consecutive settlements: enough time to place a hedge? */
export function timeGaps(mix) {
  const legs = orderedLegs(mix);
  return legs.slice(0, -1).map((leg, i) => {
    const minutes = Math.round((Date.parse(legs[i + 1].settlesAt) - Date.parse(leg.settlesAt)) / 60000);
    const status = minutes >= mix.recommendedGapMinutes ? 'sufficient' : minutes >= mix.minimumGapMinutes ? 'limited' : 'insufficient';
    return { fromLegId: leg.id, toLegId: legs[i + 1].id, minutes, status };
  });
}

export function lockMix(mix, { overrideReason = '' } = {}) {
  if (mix.status !== 'draft') throw new MixError('This Mix is already locked.');
  if (mix.legs.length < 2) throw new MixError('A Mix needs at least two legs.');
  if (mix.cashStake + mix.bonusStake + mix.freeBetStake <= 0) throw new MixError('Enter at least one stake portion.');
  const tight = timeGaps(mix).filter(g => g.status === 'insufficient');
  if (tight.length && !String(overrideReason).trim()) throw new MixError('Some legs settle too close together to hedge. Give an override reason to lock anyway.');
  const next = clone(mix);
  next.status = 'running';
  next.lockedOdds = combinedOdds(mix);
  return log(next, 'locked', { overrideReason: tight.length ? overrideReason : undefined });
}

/** Current valuation of the main ticket. */
export function values(mix) {
  const odds = combinedOdds(mix);
  const cash = r6(mix.cashStake * odds);
  const bonus = r6(mix.bonusStake * odds);
  const freeBetProvisional = r6(mix.freeBetStake * odds);
  const freeBetTrue = r6(mix.freeBetStake * Math.max(0, odds - 1));
  return {
    combinedOdds: odds,
    cashPotential: cash,
    bonusPotential: bonus,
    freeBetProvisional,
    freeBetTrue,
    freeBetCurrent: mix.freeBetDeducted ? freeBetTrue : freeBetProvisional,
    potential: r6(cash + bonus + (mix.freeBetDeducted ? freeBetTrue : freeBetProvisional)),
    truePotential: r6(cash + bonus + freeBetTrue),
    totalStake: r6(mix.cashStake + mix.bonusStake + mix.freeBetStake)
  };
}

export function addHedge(mix, hedge) {
  const leg = activeLeg(mix);
  if (!leg) throw new MixError('Hedges can only be added while a leg is active.');
  const stake = Number(hedge.stake);
  const odds = Number(hedge.odds);
  if (!(stake > 0) || !(odds > 1)) throw new MixError('A hedge needs a positive stake and odds above 1.');
  if (!['selection', 'against'].includes(hedge.side)) throw new MixError('A hedge backs either the selection or against it.');
  const next = clone(mix);
  const id = hedge.id || `hedge-${mix.hedges.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  next.hedges.push({ id, legId: leg.id, side: hedge.side, stake, odds, accountId: hedge.accountId || null, status: 'open', payout: 0 });
  return log(next, 'hedge_added', { hedgeId: id, legId: leg.id });
}

/** Settle the active leg (only the active leg, in order). */
export function settleLeg(mix, legId, result) {
  const leg = activeLeg(mix);
  if (!leg || leg.id !== legId) throw new MixError('Only the current active leg can be settled.');
  if (!['won', 'lost', 'void'].includes(result)) throw new MixError('A leg result is won, lost or void.');
  const next = clone(mix);
  const target = next.legs.find(l => l.id === legId);
  target.status = result;
  for (const h of next.hedges.filter(h => h.legId === legId && h.status === 'open')) {
    const wins = result === 'void' ? null : (result === 'won') === (h.side === 'selection');
    h.status = wins === null ? 'void' : wins ? 'won' : 'lost';
    h.payout = wins === null ? h.stake : wins ? r6(h.stake * h.odds) : 0;
  }
  if (result === 'lost') {
    next.legs.forEach(l => { if (l.status === 'pending') l.status = 'cancelled'; });
    next.status = 'lost';
  } else {
    if (result === 'won' && !next.freeBetDeducted) next.freeBetDeducted = true; // deduction applies exactly once
    next.status = activeLeg(next) ? 'running' : 'completed';
  }
  return log(next, 'leg_settled', { legId, result });
}

/** Two-branch exposure for the active leg, including open hedges on it. */
export function position(mix) {
  const leg = activeLeg(mix);
  const v = values(mix);
  const open = mix.hedges.filter(h => leg && h.legId === leg.id && h.status === 'open');
  const settledHedgeReturn = sum(mix.hedges.filter(h => h.status !== 'open'), h => h.payout);
  const hedgeStake = sum(mix.hedges, h => h.stake);
  const ticket = mix.freeBetDeducted ? v.truePotential : v.potential;
  const ifWins = r6(ticket + sum(open.filter(h => h.side === 'selection'), h => h.stake * h.odds) + settledHedgeReturn);
  const ifLoses = r6(sum(open.filter(h => h.side === 'against'), h => h.stake * h.odds) + settledHedgeReturn);
  const capital = r6(v.totalStake + hedgeStake);
  return { activeLegId: leg?.id ?? null, ifWins, ifLoses, worst: r6(Math.min(ifWins, ifLoses) - capital), best: r6(Math.max(ifWins, ifLoses) - capital), imbalance: r6(Math.abs(ifWins - ifLoses)), capital };
}

/** Suggest (never place) a hedge that balances the two branches at the given odds. */
export function suggestHedge(mix, odds) {
  const p = position(mix);
  if (!p.activeLegId || !(odds > 1)) return null;
  const side = p.ifWins > p.ifLoses ? 'against' : 'selection';
  // Gross returns: a hedge of x at `odds` adds x*odds to the weaker branch, so x = imbalance / odds.
  const stake = r6(p.imbalance / odds);
  return { legId: p.activeLegId, side, stake, odds, expectedReturn: r6(stake * odds) };
}

export function settlement(mix) {
  const v = values(mix);
  const won = mix.status === 'completed';
  const ticket = won ? r6(v.cashPotential + v.bonusPotential + v.freeBetTrue) : 0;
  const hedgeReturn = sum(mix.hedges, h => h.payout);
  const hedgeStake = sum(mix.hedges, h => h.stake);
  // A free bet's stake is not the player's money, so it is not counted as capital spent.
  const spent = r6(mix.cashStake + mix.bonusStake + hedgeStake);
  const returned = r6(ticket + hedgeReturn);
  return { ticketReturn: ticket, hedgeReturn: r6(hedgeReturn), spent, returned, net: r6(returned - spent), freeBetConversion: mix.freeBetStake ? r6((returned - spent) / mix.freeBetStake * 100) : null };
}
