import { byId, api, html, mount, modal, closeModal, onSubmit, toast, $$ } from '../../assets/ui.js';
import { fmt, pill, options, canOperate, today, toInput } from '../common.js';

let status = 'open';
const NEXT = { requested: ['delayed', 'verification', 'problem', 'received', 'cancelled'], delayed: ['verification', 'problem', 'received', 'cancelled'], verification: ['delayed', 'problem', 'received', 'cancelled'], problem: ['delayed', 'verification', 'received', 'cancelled'] };

export async function render(target, app) {
  const rows = await api(`/api/withdrawals?status=${status === 'all' ? '' : status}`);
  mount(target, html`<div class="page-head"><div><h1>Withdrawals</h1><p>Money stays on the platform (but is held) until arrival is confirmed. A smaller arrival is booked as a fee.</p></div></div>
    <div class="tabs">${[['open', 'In progress'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => html`<button type="button" data-s="${v}" class="${status === v ? 'active' : ''}">${l}</button>`)}</div>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Requested</th><th>From</th><th>To</th><th class="num">Amount</th><th>Status</th><th>Waiting</th><th></th></tr></thead><tbody>
      ${rows.map(w => html`<tr><td>${w.requested_on}<br><small>${w.client_name}</small></td><td>${w.platform_account}</td><td>${w.destination}</td>
        <td class="num">${fmt(w.amount, w.currency)}${w.received_amount != null ? html`<br><small>received ${fmt(w.received_amount, w.currency)}</small>` : ''}</td>
        <td>${pill(w.status)}${w.reason ? html`<br><small>${w.reason}</small>` : ''}</td><td>${w.days_waiting} day(s)${w.expected_on ? html`<br><small>expected ${w.expected_on}</small>` : ''}</td>
        <td>${canOperate() && NEXT[w.status] ? html`<button type="button" data-update="${w.id}">Update</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">Nothing here.</p>`}</section>`);
  $$('[data-s]', target).forEach(b => b.addEventListener('click', () => { status = b.dataset.s; render(target, app); }));
  $$('[data-update]', target).forEach(b => b.addEventListener('click', () => {
    const w = rows.find(r => r.id === b.dataset.update);
    const d = modal({ title: 'Update withdrawal', subtitle: `${w.platform_account} → ${w.destination} · ${fmt(w.amount, w.currency)}`, body: html`<form id="f" class="form-grid">
      <div class="full"><label for="s">New status</label><select id="s" name="status">${options(NEXT[w.status].map(s => ({ value: s, label: s })), 'received')}</select></div>
      <div><label for="ra">Amount received</label><input id="ra" name="receivedAmount" inputmode="decimal" value="${toInput(w.amount, w.currency)}"></div><div><label for="ro">Received on</label><input id="ro" name="receivedOn" type="date" value="${today()}"></div>
      <div class="full"><label for="r">Reason / note</label><input id="r" name="reason" maxlength="300"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(byId(d, 'f'), async data => { await api(`/api/withdrawals/${w.id}`, { method: 'PATCH', body: data }); closeModal(); toast('Withdrawal updated.'); render(target, app); });
  }));
}
