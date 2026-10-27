import { html, raw } from '../assets/ui.js';

export const ctx = { me: null };
const decimals = c => ctx.me?.currencyDecimals?.[c] ?? 2;

/** Minor units -> "1,234.50 USD" */
export function fmt(minor, currency, { sign = false } = {}) {
  if (minor == null) return '—';
  const d = decimals(currency);
  const value = (minor / 10 ** d).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${sign && minor > 0 ? '+' : ''}${value} ${currency}`;
}
export const signed = (minor, currency) => html`<span class="${minor < 0 ? 'neg' : minor > 0 ? 'pos' : ''}">${fmt(minor, currency, { sign: true })}</span>`;
/** Minor -> plain decimal string for form inputs */
export const toInput = (minor, currency) => (minor / 10 ** decimals(currency)).toFixed(decimals(currency));

const TONES = { active: 'green', open: 'amber', requested: 'amber', delayed: 'red', verification: 'red', problem: 'red', received: 'green', cancelled: 'grey', reserved: 'amber', placed: '', won: 'green', lost: 'red', void: 'grey', planning: 'amber', live: 'green', closed: 'grey', pending: 'amber', approved: 'green', rejected: 'red', completed: 'green', failed: 'red', paused: 'grey', draft: 'amber', running: '', done: 'green', dismissed: 'grey', ready: 'green', turnover: 'amber', withdrawable: 'green', withdrawing: 'amber' };
export const pill = (status, label = String(status).replaceAll('_', ' ')) => html`<span class="pill ${TONES[status] ?? ''}">${label}</span>`;
export const selected = c => (c ? raw('selected') : '');
export const checked = c => (c ? raw('checked') : '');
export const options = (list, current, { blank = null } = {}) => html`${blank !== null ? html`<option value="">${blank}</option>` : ''}${list.map(o => html`<option value="${o.value}" ${selected(String(o.value) === String(current ?? ''))}>${o.label}</option>`)}`;
export const today = () => new Date().toLocaleDateString('en-CA');
export const isOwner = () => ctx.me.user.role === 'owner';
export const canOperate = () => ctx.me.user.role !== 'shareholder';

/** Flatten /api/structure into account options. */
export function accountOptions(tree, filter = () => true) {
  return tree.flatMap(c => c.holders.flatMap(h => h.accounts.filter(filter).map(a => ({ value: a.id, label: `${c.code} · ${h.name} · ${a.name} (${a.currency})`, account: a, holder: h, client: c }))));
}
