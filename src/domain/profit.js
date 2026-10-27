// Shareholder profit distribution. Integer minor units throughout; rounding
// is done once per shareholder (half-up) and any remainder stays with the
// company, so payable + retained always equals the profit exactly.
//
// Fix over v1: v1 divided each shareholder's base investment by a company
// total that included approved top-ups, so shares never added up to 100%.
// Here the same capital figure (investment + approved contributions) is used
// on both sides of the ratio.

/** a / b rounded half away from zero, exact for any integers (BigInt). */
export function roundDiv(a, b) {
  const A = BigInt(a); const B = BigInt(b);
  const negative = (A < 0n) !== (B < 0n);
  const absA = A < 0n ? -A : A; const absB = B < 0n ? -B : B;
  const q = (2n * absA + absB) / (2n * absB);
  return Number(negative ? -q : q);
}

export function distribute({ shareholders, profit }) {
  const active = shareholders.filter(s => s.status === 'active');
  const totalCapital = active.reduce((t, s) => t + s.capital, 0);
  const rows = active.map(s => {
    const gross = totalCapital > 0 ? roundDiv(BigInt(profit) * BigInt(s.capital), totalCapital) : 0;
    const payable = roundDiv(BigInt(gross) * BigInt(s.profitShareBp), 10000);
    return { shareholderId: s.id, clientId: s.clientId, capital: s.capital, ratio: totalCapital ? s.capital / totalCapital : 0, gross, payable, retained: gross - payable, paid: s.paid, unpaid: payable - s.paid };
  });
  const allocated = rows.reduce((t, r) => t + r.gross, 0);
  return { profit, totalCapital, rows, roundingRemainder: profit - allocated, totalPayable: rows.reduce((t, r) => t + r.payable, 0) };
}
