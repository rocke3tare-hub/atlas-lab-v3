// Stake calculator. Each outcome pays a known multiple of its stake in each
// match scenario; the planner chooses stakes that MAXIMISE THE WORST-CASE
// RETURN (a max-min linear programme solved exactly with the simplex method),
// subject to total capital, per-outcome minimums/maximums and locked stakes.
// For mutually exclusive outcomes this equalises the scenarios exactly;
// with Draw-No-Bet or double-chance outcomes it finds the true best guarantee
// instead of the heuristic search used in v1.

export const MARKET_TYPES = {
  two_way: { label: 'Two outcomes', scenarios: ['team1', 'team2'] },
  three_way: { label: 'Three outcomes (1X2)', scenarios: ['team1', 'draw', 'team2'] }
};
export const SCENARIO_LABELS = { team1: 'Team 1 wins', draw: 'Draw', team2: 'Team 2 wins' };

/** Return multiple per scenario for one unit staked at odds `o`. */
export const OUTCOME_TYPES = {
  team1_win: { label: 'Team 1 win', pays: o => ({ team1: o }) },
  draw: { label: 'Draw', pays: o => ({ draw: o }), threeWayOnly: true },
  team2_win: { label: 'Team 2 win', pays: o => ({ team2: o }) },
  team1_dnb: { label: 'Team 1 draw-no-bet', pays: o => ({ team1: o, draw: 1 }), threeWayOnly: true },
  team2_dnb: { label: 'Team 2 draw-no-bet', pays: o => ({ team2: o, draw: 1 }), threeWayOnly: true },
  dc_1x: { label: 'Double chance 1X', pays: o => ({ team1: o, draw: o }), threeWayOnly: true },
  dc_x2: { label: 'Double chance X2', pays: o => ({ draw: o, team2: o }), threeWayOnly: true },
  dc_12: { label: 'Double chance 12', pays: o => ({ team1: o, team2: o }), threeWayOnly: true }
};

const EPS = 1e-9;

/**
 * Maximise c·x subject to A·x <= b, x >= 0, with b >= 0 (origin feasible).
 * Dense tableau simplex with Bland's rule (no cycling). Sizes here are tiny.
 * Returns { x, value } or { unbounded: true }.
 */
export function simplex(A, b, c) {
  const m = A.length;
  const n = c.length;
  if (b.some(v => v < -EPS)) throw new Error('simplex requires b >= 0');
  // Tableau rows: [A | I | b]; objective row: [-c | 0 | 0].
  const T = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)), Math.max(0, b[i])]);
  const z = [...c.map(v => -v), ...Array(m).fill(0), 0];
  const basis = Array.from({ length: m }, (_, i) => n + i);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let pivotCol = -1;
    for (let j = 0; j < n + m; j += 1) if (z[j] < -EPS) { pivotCol = j; break; } // Bland: lowest index
    if (pivotCol === -1) break;
    let pivotRow = -1;
    let best = Infinity;
    for (let i = 0; i < m; i += 1) {
      if (T[i][pivotCol] > EPS) {
        const ratio = T[i][n + m] / T[i][pivotCol];
        if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i] < basis[pivotRow])) { best = ratio; pivotRow = i; }
      }
    }
    if (pivotRow === -1) return { unbounded: true };
    const p = T[pivotRow][pivotCol];
    T[pivotRow] = T[pivotRow].map(v => v / p);
    for (let i = 0; i < m; i += 1) {
      if (i === pivotRow) continue;
      const f = T[i][pivotCol];
      if (Math.abs(f) > EPS) T[i] = T[i].map((v, j) => v - f * T[pivotRow][j]);
    }
    const f = z[pivotCol];
    for (let j = 0; j <= n + m; j += 1) z[j] -= f * T[pivotRow][j];
    basis[pivotRow] = pivotCol;
  }
  const x = Array(n).fill(0);
  basis.forEach((variable, i) => { if (variable < n) x[variable] = T[i][n + m]; });
  return { x, value: z[n + m] };
}

/** Build the scenario x outcome payoff matrix. */
export function payoffMatrix(marketType, outcomes) {
  const market = MARKET_TYPES[marketType];
  if (!market) throw new Error(`Unknown market type ${marketType}`);
  return market.scenarios.map(scenario => outcomes.map(o => OUTCOME_TYPES[o.type].pays(o.odds)[scenario] || 0));
}

function evaluate(matrix, stakes) {
  const total = stakes.reduce((s, v) => s + v, 0);
  const returns = matrix.map(row => row.reduce((s, f, i) => s + f * stakes[i], 0));
  return { total, returns, profits: returns.map(r => r - total) };
}

/**
 * Plan stakes (all money in major units here; the caller converts to minor units).
 * input: { marketType, mode: 'balanced'|'target'|'manual', capital, targetReturn, increment,
 *          outcomes: [{ type, odds, stake?, locked?, min?, max? }] }
 */
export function plan(input) {
  const warnings = [];
  const market = MARKET_TYPES[input.marketType];
  if (!market) throw new Error('Unknown market type');
  const outcomes = input.outcomes.map(o => ({ ...o, odds: Number(o.odds), stake: Number(o.stake || 0), min: Number(o.min || 0), max: o.max === '' || o.max == null ? Infinity : Number(o.max) }));
  for (const o of outcomes) {
    if (!OUTCOME_TYPES[o.type]) throw new Error(`Unknown outcome type ${o.type}`);
    if (OUTCOME_TYPES[o.type].threeWayOnly && input.marketType === 'two_way') throw new Error(`${OUTCOME_TYPES[o.type].label} needs a three-outcome market.`);
    if (!(o.odds > 1)) throw new Error('Every outcome needs odds above 1.');
    if (o.min > o.max) throw new Error(`${OUTCOME_TYPES[o.type].label}: minimum stake is above the maximum.`);
  }
  if (!outcomes.length) throw new Error('Add at least one outcome.');
  const matrix = payoffMatrix(input.marketType, outcomes);
  const uncovered = market.scenarios.filter((_, s) => matrix[s].every(f => f === 0));
  if (uncovered.length) warnings.push(`No outcome covers: ${uncovered.map(s => SCENARIO_LABELS[s]).join(', ')}. That result loses the whole stake.`);
  const increment = Number(input.increment) > 0 ? Number(input.increment) : 0.01;

  let stakes;
  if (input.mode === 'manual') {
    stakes = outcomes.map(o => o.stake);
  } else if (input.mode === 'target') {
    const target = Number(input.targetReturn);
    if (!(target > 0)) throw new Error('Enter a positive target return.');
    const unit = solveMaxMin(matrix, outcomes.map(() => 0), outcomes.map(() => Infinity), 1);
    if (!(unit.value > EPS)) throw new Error('These outcomes cannot guarantee any return in every scenario.');
    stakes = roundStakes(matrix, unit.stakes.map(s => (s * target) / unit.value), outcomes.map(() => 0), outcomes.map(() => Infinity), increment, 'up');
    outcomes.forEach((o, i) => { if (stakes[i] > o.max + EPS) warnings.push(`${OUTCOME_TYPES[o.type].label} needs ${stakes[i].toFixed(2)}, above its maximum stake.`); });
    if (Number(input.capital) > 0 && stakes.reduce((s, v) => s + v, 0) > Number(input.capital) + EPS) warnings.push('The target needs more than the available capital.');
  } else {
    const capital = Number(input.capital);
    if (!(capital > 0)) throw new Error('Enter the capital to place.');
    const lo = outcomes.map(o => (o.locked ? o.stake : o.min));
    const hi = outcomes.map(o => (o.locked ? o.stake : o.max));
    const floor = lo.reduce((s, v) => s + v, 0);
    if (floor > capital + EPS) throw new Error('Locked and minimum stakes already exceed the capital.');
    const solved = solveMaxMin(matrix, lo, hi, capital);
    stakes = roundStakes(matrix, spreadLeftover(solved.stakes, hi, capital), lo, hi, increment, 'balance', capital);
    outcomes.forEach((o, i) => {
      if (!o.locked && Number.isFinite(o.max) && stakes[i] >= o.max - EPS) warnings.push(`${OUTCOME_TYPES[o.type].label} is at its maximum stake, which limits the guaranteed return.`);
    });
    const placed = stakes.reduce((s, v) => s + v, 0);
    if (capital - placed >= increment - EPS) warnings.push(`${(capital - placed).toFixed(2)} of the capital could not be placed within the maximum stakes.`);
  }

  outcomes.forEach((o, i) => {
    if (stakes[i] + EPS < o.min && !o.locked) warnings.push(`${OUTCOME_TYPES[o.type].label} is below its minimum stake.`);
    if (stakes[i] > o.max + EPS && input.mode !== 'target') warnings.push(`${OUTCOME_TYPES[o.type].label} exceeds its maximum stake.`);
  });
  const result = evaluate(matrix, stakes);
  const exclusive = outcomes.every(o => ['team1_win', 'draw', 'team2_win'].includes(o.type)) && new Set(outcomes.map(o => o.type)).size === outcomes.length && uncovered.length === 0;
  const bookPercent = exclusive ? outcomes.reduce((s, o) => s + 1 / o.odds, 0) * 100 : null;
  const worst = Math.min(...result.profits);
  return {
    stakes,
    totalStake: result.total,
    scenarios: market.scenarios.map((s, i) => ({ scenario: s, label: SCENARIO_LABELS[s], grossReturn: result.returns[i], profit: result.profits[i] })),
    worstProfit: worst,
    bestProfit: Math.max(...result.profits),
    guaranteedReturnPercent: result.total > 0 ? (Math.min(...result.returns) / result.total) * 100 : 0,
    bookPercent,
    arbitrage: worst > EPS,
    warnings
  };
}

/** Max-min LP: stakes s = lo + y, maximise R with R <= return_s for every scenario. */
function solveMaxMin(matrix, lo, hi, capital) {
  const n = lo.length;
  const A = [];
  const b = [];
  for (const row of matrix) {
    A.push([...row.map(f => -f), 1]);
    b.push(row.reduce((s, f, i) => s + f * lo[i], 0));
  }
  if (Number.isFinite(capital)) { A.push([...Array(n).fill(1), 0]); b.push(capital - lo.reduce((s, v) => s + v, 0)); }
  hi.forEach((h, i) => { if (Number.isFinite(h)) { const r = Array(n + 1).fill(0); r[i] = 1; A.push(r); b.push(h - lo[i]); } });
  const result = simplex(A, b, [...Array(n).fill(0), 1]);
  if (result.unbounded) throw new Error('The plan is unbounded; set a capital amount.');
  return { stakes: result.x.slice(0, n).map((y, i) => lo[i] + y), value: result.value };
}

/**
 * The LP may stop placing capital once the worst case cannot improve (for
 * example when another outcome is capped). Extra stake never lowers any
 * scenario, so spread the leftover over outcomes with room, in proportion to
 * their current stakes, which keeps the upside balanced.
 */
function spreadLeftover(stakes, hi, capital) {
  const result = stakes.slice();
  for (let pass = 0; pass < result.length + 1; pass += 1) {
    const leftover = capital - result.reduce((s, v) => s + v, 0);
    if (leftover <= EPS) break;
    const open = result.map((v, i) => (hi[i] - v > EPS ? i : -1)).filter(i => i >= 0);
    if (!open.length) break;
    const weight = open.reduce((s, i) => s + result[i], 0);
    for (const i of open) {
      const share = weight > EPS ? (leftover * result[i]) / weight : leftover / open.length;
      result[i] = Math.min(hi[i], result[i] + share);
    }
  }
  return result;
}

/**
 * Snap stakes to the increment without losing the guarantee more than needed:
 * floor everything, then hand out the remaining increments one at a time to
 * whichever outcome most improves the worst scenario (ties: lowest index).
 */
function roundStakes(matrix, raw, lo, hi, increment, mode, capital = Infinity) {
  const units = v => Math.round(v / increment);
  let stakes = raw.map((v, i) => Math.max(lo[i], Math.floor(v / increment + 1e-7) * increment));
  if (mode === 'up') {
    // Target mode: round each stake up so every scenario reaches the target.
    return raw.map(v => Math.ceil(v / increment - 1e-7) * increment).map(v => Number(v.toFixed(8)));
  }
  let remaining = units(capital) - units(stakes.reduce((s, v) => s + v, 0));
  let guard = stakes.length * 4 + 8;
  while (remaining > 0 && guard-- > 0) {
    let bestIndex = -1;
    let bestWorst = -Infinity;
    for (let i = 0; i < stakes.length; i += 1) {
      if (stakes[i] + increment > hi[i] + EPS) continue;
      const trial = stakes.slice();
      trial[i] += increment;
      const worst = Math.min(...matrix.map(row => row.reduce((s, f, j) => s + f * trial[j], 0)));
      if (worst > bestWorst + EPS) { bestWorst = worst; bestIndex = i; }
    }
    if (bestIndex === -1) break;
    stakes[bestIndex] += increment;
    remaining -= 1;
  }
  return stakes.map(v => Number(v.toFixed(8)));
}

/** A free bet returns winnings only: stake x (odds - 1). */
export function freeBetValue(stake, odds) {
  return { effectiveOdds: odds - 1, potentialWin: stake * (odds - 1) };
}
