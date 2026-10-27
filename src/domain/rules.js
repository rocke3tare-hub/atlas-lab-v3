// Platform rules, eligibility of a platform account for a planned stake, and
// turnover (wagering) progress. All amounts are integer minor units; odds are
// integer thousandths. Pure functions.

export const TURNOVER_BASES = { deposit: 'Deposits', bonus: 'Bonus credited', deposit_plus_bonus: 'Deposits + bonus' };

export const DEFAULT_RULE = Object.freeze({
  minOdds: 1000, maxOdds: 0, maxStake: 0, maxPayout: 0,
  turnoverBp: 10000, turnoverBase: 'deposit',
  maxOutcomesPerEvent: 1, multipleAccountsPerOutcome: false, manualApproval: false
});

/**
 * Turnover required = base x turnover%; completed = stakes on settled bets at
 * or above the rule's minimum odds (bonus and free-bet stakes count too only
 * if `countBonusStakes`). Never stored, always derived.
 */
export function turnover({ deposits, bonusCredited, eligibleStakes }, rule) {
  const base = rule.turnoverBase === 'bonus' ? bonusCredited : rule.turnoverBase === 'deposit_plus_bonus' ? deposits + bonusCredited : deposits;
  const required = Math.round((base * rule.turnoverBp) / 10000);
  const completed = eligibleStakes;
  return { base, required, completed, remaining: Math.max(0, required - completed), percent: required ? Math.min(100, Math.round((completed / required) * 1000) / 10) : 100 };
}

/**
 * Can this account take `stake` at `odds` on (event, outcome)?
 * ctx: { account, rule, available, reservations: [{accountId, eventKey, outcome, stake}], outcome, eventKey }
 * Returns { status: 'ok'|'review'|'blocked', reasons[], maxStake }.
 * v1 compared every reservation against the full balance independently, so
 * several reservations could overspend; here `available` is already net of
 * every open reservation on the account.
 */
export function eligibility({ account, rule, available, reservations, eventKey, outcome, stake, odds }) {
  const blocked = [];
  const review = [];
  if (account.status !== 'active') blocked.push(`Account is ${account.status}.`);
  if (account.kycStatus !== 'verified') blocked.push('Account identity verification is not complete.');
  if (!(stake > 0)) blocked.push('Stake must be positive.');
  if (odds < rule.minOdds) blocked.push(`Odds are below the platform minimum of ${(rule.minOdds / 1000).toFixed(2)}.`);
  if (rule.maxOdds && odds > rule.maxOdds) blocked.push(`Odds are above the platform maximum of ${(rule.maxOdds / 1000).toFixed(2)}.`);
  if (rule.maxStake && stake > rule.maxStake) blocked.push('Stake is above the platform maximum stake.');
  const payout = Math.round((stake * odds) / 1000);
  if (rule.maxPayout && payout > rule.maxPayout) blocked.push('Potential payout is above the platform maximum payout.');
  if (stake > available) blocked.push('Not enough available balance after existing reservations.');
  const onEvent = reservations.filter(r => r.eventKey === eventKey);
  const mineOnEvent = onEvent.filter(r => r.accountId === account.id);
  const outcomes = new Set(mineOnEvent.map(r => r.outcome));
  if (!outcomes.has(outcome) && outcomes.size + 1 > rule.maxOutcomesPerEvent) blocked.push(`This platform allows ${rule.maxOutcomesPerEvent} outcome(s) per event on one account.`);
  if (!rule.multipleAccountsPerOutcome && onEvent.some(r => r.outcome === outcome && r.accountId !== account.id && r.platformId === account.platformId)) blocked.push('Another account on this platform already covers this outcome.');
  if (rule.manualApproval) review.push('This platform requires owner approval for every stake.');
  let max = available;
  if (rule.maxStake) max = Math.min(max, rule.maxStake);
  if (rule.maxPayout && odds) max = Math.min(max, Math.floor((rule.maxPayout * 1000) / odds));
  return { status: blocked.length ? 'blocked' : review.length ? 'review' : 'ok', reasons: [...blocked, ...review], maxStake: Math.max(0, max), payout };
}

/** Readiness summary for an account (replaces v1 "health"; no identity-rotation advice). */
export function readiness({ account, available, turnoverInfo, pendingWithdrawals }) {
  if (account.status !== 'active') return { state: 'paused', reason: `Account is ${account.status}.` };
  if (account.kycStatus !== 'verified') return { state: 'verification', reason: 'Identity verification is not complete.' };
  if (turnoverInfo.required && turnoverInfo.remaining > 0) return { state: 'turnover', reason: `${turnoverInfo.percent}% of the turnover requirement is done.` };
  if (pendingWithdrawals > 0) return { state: 'withdrawing', reason: 'A withdrawal is on its way.' };
  if (available > 0 && turnoverInfo.required && turnoverInfo.remaining === 0) return { state: 'withdrawable', reason: 'Turnover is complete; the balance can be withdrawn.' };
  return { state: 'ready', reason: 'Active and verified.' };
}
