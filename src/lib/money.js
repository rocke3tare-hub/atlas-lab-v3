// Money is stored as integer minor units per currency (cents for USD, whole
// units for IRR). Odds and calculator plans may use decimals; anything that
// is booked to a balance is converted to minor units first.
import { AppError } from './errors.js';

export const CURRENCIES = {
  USD: { decimals: 2, label: 'US dollar' },
  EUR: { decimals: 2, label: 'Euro' },
  USDT: { decimals: 2, label: 'Tether (USDT)' },
  GBP: { decimals: 2, label: 'Pound sterling' },
  TRY: { decimals: 2, label: 'Turkish lira' },
  AED: { decimals: 2, label: 'UAE dirham' },
  IRR: { decimals: 0, label: 'Iranian rial' },
  IRT: { decimals: 0, label: 'Iranian toman' }
};

export function assertCurrency(code) {
  if (!CURRENCIES[code]) throw new AppError('VALIDATION_ERROR', `Unsupported currency: ${code}.`, 422, { field: 'currency' });
  return code;
}

/**
 * Parse a decimal string like "1,250.5" into minor units for the currency,
 * rejecting more decimals than the currency allows (no silent rounding).
 */
export function toMinor(value, currency, field = 'Amount', { allowZero = true, allowNegative = false } = {}) {
  assertCurrency(currency);
  const { decimals } = CURRENCIES[currency];
  const text = String(value ?? '').replace(/[,\s]/g, '').trim();
  const pattern = decimals ? new RegExp(`^(-)?(\\d{1,13})(?:\\.(\\d{1,${decimals}}))?$`) : /^(-)?(\d{1,15})$/;
  const match = pattern.exec(text);
  if (!match) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a number with at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`, 422, { field });
  }
  const [, sign, whole, frac = ''] = match;
  let minor = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || 0);
  if (sign) minor = -minor;
  if (!Number.isSafeInteger(minor)) throw new AppError('VALIDATION_ERROR', `${field} is too large.`, 422, { field });
  if (minor < 0 && !allowNegative) throw new AppError('VALIDATION_ERROR', `${field} cannot be negative.`, 422, { field });
  if (minor === 0 && !allowZero) throw new AppError('VALIDATION_ERROR', `${field} must be greater than zero.`, 422, { field });
  return minor;
}

export function fromMinor(minor, currency) {
  return minor / 10 ** CURRENCIES[currency].decimals;
}

/** Round a planning amount (float in major units) to minor units, half away from zero. */
export function roundToMinor(major, currency) {
  const factor = 10 ** CURRENCIES[currency].decimals;
  const scaled = major * factor;
  return Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
}

export function formatMinor(minor, currency) {
  const { decimals } = CURRENCIES[currency] || { decimals: 2 };
  return `${(minor / 10 ** decimals).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${currency}`;
}

/** Odds are decimal (European) odds stored as integer thousandths: 1.905 -> 1905. */
export function parseOdds(value, field = 'Odds') {
  const text = String(value ?? '').trim();
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(text) || Number(text) <= 1) throw new AppError('VALIDATION_ERROR', `${field} must be decimal odds above 1.00 with at most 3 decimals.`, 422, { field });
  return Math.round(Number(text) * 1000);
}
export const oddsToNumber = thousandths => thousandths / 1000;

/** Percentages are stored as basis points: 12.5% -> 1250. */
export function parsePercent(value, field = 'Percentage', { max = 100 } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text) || Number(text) > max) throw new AppError('VALIDATION_ERROR', `${field} must be between 0 and ${max} with at most 2 decimals.`, 422, { field });
  return Math.round(Number(text) * 100);
}

/** amount * bp / 10000, half-up, integer arithmetic. Works for negative amounts symmetrically. */
export function applyBasisPoints(amount, bp) {
  const sign = amount < 0 ? -1n : 1n;
  const result = (BigInt(Math.abs(amount)) * BigInt(bp) + 5000n) / 10000n;
  return Number(sign * result);
}
