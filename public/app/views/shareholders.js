import { api, html, mount, modal, closeModal, onSubmit, toast, showError, $, $$ } from '../../assets/ui.js';
import { fmt, signed, pill, options, isOwner, accountOptions, today } from '../common.js';

let range = { from: '', to: '' };

export async function render(target, app) {
  const [dist, payments, contributions, tree] = await Promise.all([api(`/api/distribution?${new URLSearchParams(range)}`), api('/api/payments'), api('/api/contributions'), api('/api/structure')]);
  const c = dist.currency;
  mount(target, html`<div class="page-head"><div><h1>Shareholders</h1><p>Profit is attributed by capital share; each shareholder is paid their agreed percentage of it. Figures in ${c}.</p></div>
      <div class="btn-row"><button type="button" id="contribute">Add capital</button>${isOwner() ? html`<button type="button" class="primary" id="pay">Record payment</button>` : ''}</div></div>
    <form class="toolbar" id="range"><div class="filters"><div><label for="f">From</label><input id="f" type="date" name="from" value="${range.from}"></div><div><label for="t">To</label><input id="t" type="date" name="to" value="${range.to}"></div><button type="submit">Apply</button></div>
      ${dist.profit !== undefined ? html`<div><b>Company result ${signed(dist.profit, c)}</b> <small>on capital ${fmt(dist.totalCapital, c)}${dist.roundingRemainder ? ` · rounding ${fmt(dist.roundingRemainder, c)}` : ''}</small></div>` : ''}</form>
    ${dist.excluded.length ? html`<p class="notice">Not in this distribution (invested in another currency): ${dist.excluded.join(', ')}.</p>` : ''}
    <section class="card"><h3>Distribution</h3>${dist.rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Shareholder</th><th class="num">Capital</th><th class="num">Share of capital</th><th class="num">Attributed result</th><th class="num">Payable</th><th class="num">Retained by company</th><th class="num">Paid</th><th class="num">Unpaid</th></tr></thead><tbody>
      ${dist.rows.map(r => html`<tr><td><b>${r.clientName}</b></td><td class="num">${fmt(r.capital, c)}</td><td class="num">${(r.ratio * 100).toFixed(2)}%</td><td class="num">${signed(r.gross, c)}</td><td class="num">${fmt(r.payable, c)}</td><td class="num">${fmt(r.retained, c)}</td><td class="num">${fmt(r.paid, c)}</td><td class="num"><b>${fmt(r.unpaid, c)}</b></td></tr>`)}</tbody></table></div>` : html`<p class="empty">No active shareholders.</p>`}</section>
    <div class="grid two"><section class="card"><h3>Payments</h3>${payments.length ? html`<div class="list">${payments.map(p => html`<div class="list-item"><div><b>${p.client_name}</b> · ${fmt(p.amount, p.currency)}<br><small>${p.created_at.slice(0, 10)}${p.from_account ? ` · from ${p.from_account}` : ''}${p.note ? ` · ${p.note}` : ''}</small></div>
        <div>${pill(p.status)} ${isOwner() && p.status === 'pending' ? html`<button type="button" data-complete="${p.id}">Paid</button><button type="button" data-fail="${p.id}">Failed</button>` : ''}</div></div>`)}</div>` : html`<p class="empty">No payments.</p>`}</section>
      <section class="card"><h3>Capital contributions</h3>${contributions.length ? html`<div class="list">${contributions.map(k => html`<div class="list-item"><div><b>${k.client_name}</b> · ${fmt(k.amount, k.currency)}<br><small>${k.requested_by_name} · ${k.created_at.slice(0, 10)}${k.note ? ` · ${k.note}` : ''}</small></div>
        <div>${pill(k.status)} ${isOwner() && k.status === 'pending' ? html`<button type="button" data-approve="${k.id}">Approve</button><button type="button" data-reject="${k.id}">Reject</button>` : ''}</div></div>`)}</div>` : html`<p class="empty">No contributions.</p>`}</section></div>`);
  $('#range', target).addEventListener('submit', e => { e.preventDefault(); range = { from: e.currentTarget.from.value, to: e.currentTarget.to.value }; render(target, app); });
  const act = async (url, method, body, msg) => { try { await api(url, { method, body }); toast(msg); render(target, app); } catch (error) { showError(error); } };
  $$('[data-complete]', target).forEach(b => b.addEventListener('click', () => act(`/api/payments/${b.dataset.complete}`, 'PATCH', { status: 'completed', paidOn: today() }, 'Payment completed.')));
  $$('[data-fail]', target).forEach(b => b.addEventListener('click', () => act(`/api/payments/${b.dataset.fail}`, 'PATCH', { status: 'failed' }, 'Payment marked failed.')));
  $$('[data-approve]', target).forEach(b => b.addEventListener('click', () => act(`/api/contributions/${b.dataset.approve}/decision`, 'POST', { decision: 'approved' }, 'Capital approved.')));
  $$('[data-reject]', target).forEach(b => b.addEventListener('click', () => act(`/api/contributions/${b.dataset.reject}/decision`, 'POST', { decision: 'rejected' }, 'Capital rejected.')));
  $('#contribute', target).addEventListener('click', () => {
    const clients = tree.filter(x => x.shareholder_id);
    const d = modal({ title: 'Add capital', subtitle: 'The owner approves contributions before they count.', body: html`<form id="f" class="form-grid"><div class="full"><label for="c">Client</label><select id="c" name="clientId">${options(clients.map(x => ({ value: x.id, label: `${x.name} (${x.currency})` })), clients[0]?.id)}</select></div>
      <div><label for="a">Amount</label><input id="a" name="amount" inputmode="decimal" required></div><div><label for="n">Note</label><input id="n" name="note"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Submit</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/contributions', { method: 'POST', body: data }); closeModal(); toast('Contribution submitted.'); render(target, app); });
  });
  $('#pay', target)?.addEventListener('click', () => {
    const sh = tree.filter(x => x.shareholder_id);
    const d = modal({ title: 'Record shareholder payment', subtitle: 'Money leaves the chosen account when you mark it paid.', body: html`<form id="f" class="form-grid">
      <div class="full"><label for="s">Shareholder</label><select id="s" name="shareholderId">${options(sh.map(x => ({ value: x.shareholder_id, label: `${x.name} · unpaid ${fmt(dist.rows.find(r => r.clientId === x.id)?.unpaid ?? 0, x.currency)}` })), sh[0]?.shareholder_id)}</select></div>
      <div><label for="a">Amount</label><input id="a" name="amount" inputmode="decimal" required></div>
      <div><label for="f2">Pay from</label><select id="f2" name="fromAccountId">${options(accountOptions(tree, a => a.kind !== 'platform'), '', { blank: 'Paid outside Atlas' })}</select></div>
      <div class="full"><label for="n">Note</label><input id="n" name="note"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => { if (!data.fromAccountId) delete data.fromAccountId; await api('/api/payments', { method: 'POST', body: data }); closeModal(); toast('Payment recorded as pending.'); render(target, app); });
  });
}
