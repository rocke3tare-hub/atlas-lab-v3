import { byId, api, html, mount, modal, closeModal, onSubmit, toast, $, $$ } from '../../assets/ui.js';
import { fmt, options, canOperate, isOwner, accountOptions, today } from '../common.js';

const KINDS = [['transfer', 'Transfer between own accounts'], ['exchange', 'Currency exchange'], ['income', 'Income'], ['cost', 'Cost / expense'], ['capital', 'Capital paid in'], ['opening', 'Opening balance'], ['adjustment', 'Adjustment (owner)']];
let filter = { from: '', to: '', clientId: '' };

export async function render(target, app, [mode, accountId]) {
  const [rows, tree] = await Promise.all([api(`/api/movements?${new URLSearchParams(filter)}`), api('/api/structure')]);
  mount(target, html`<div class="page-head"><div><h1>Money movements</h1><p>Every change to a balance is a line here. Lines are never edited; corrections post a reversal.</p></div>
      <div class="btn-row">${canOperate() ? html`<button class="primary" type="button" id="new">Record movement</button>` : ''}<a class="btn" href="/api/export?format=xlsx">Export Excel</a></div></div>
    <form class="toolbar" id="filter"><div class="filters">
      <div><label for="fc">Client</label><select id="fc" name="clientId">${options(tree.map(c => ({ value: c.id, label: c.name })), filter.clientId, { blank: 'All clients' })}</select></div>
      <div><label for="ff">From</label><input id="ff" type="date" name="from" value="${filter.from}"></div><div><label for="ft">To</label><input id="ft" type="date" name="to" value="${filter.to}"></div>
      <button type="submit">Apply</button></div></form>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>From</th><th>To</th><th class="num">Out</th><th class="num">In</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows.map(m => html`<tr><td>${m.occurred_on}<br><small>${m.client_name}</small></td><td>${m.kind.replace('_', ' ')}${m.reversed ? html` <span class="pill grey">reversed</span>` : ''}</td>
        <td>${m.from_name || html`<small>outside</small>`}</td><td>${m.to_name || html`<small>outside</small>`}</td>
        <td class="num">${m.currency_out ? fmt(m.amount_out, m.currency_out) : ''}${m.fee ? html`<br><small>fee ${fmt(m.fee, m.currency_out)}</small>` : ''}</td>
        <td class="num">${m.currency_in ? fmt(m.amount_in, m.currency_in) : ''}</td><td>${m.note || ''}${m.reference ? html`<br><small>${m.reference}</small>` : ''}</td>
        <td>${isOwner() && !m.reversed && m.kind !== 'reversal' && !m.source_type ? html`<button type="button" data-reverse="${m.id}">Reverse</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No movements in this view.</p>`}</section>`);
  $('#filter', target).addEventListener('submit', e => { e.preventDefault(); const f = e.currentTarget; filter = { clientId: f.clientId.value, from: f.from.value, to: f.to.value }; render(target, app, []); });
  $$('[data-reverse]', target).forEach(b => b.addEventListener('click', () => {
    const d = modal({ title: 'Reverse movement', subtitle: 'Posts an equal and opposite line. The original stays in history.', body: html`<form id="f"><label for="r">Reason</label><input id="r" name="reason" required maxlength="300"></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="danger" type="submit">Reverse</button>` });
    onSubmit(byId(d, 'f'), async data => { await api(`/api/movements/${b.dataset.reverse}/reverse`, { method: 'POST', body: data }); closeModal(); toast('Reversal posted.'); render(target, app, []); });
  }));
  const open = (preset = null) => movementForm(tree, preset, () => { closeModal(); toast('Movement recorded.'); app.go('money'); render(target, app, []); });
  $('#new', target)?.addEventListener('click', () => open());
  if (mode === 'new' && canOperate()) open(accountId);
}

function movementForm(tree, preset, done) {
  const money = accountOptions(tree, a => a.kind !== 'platform' && a.status === 'active');
  const all = accountOptions(tree, a => a.status === 'active');
  const d = modal({ title: 'Record movement', wide: true, body: html`<form id="f" class="form-grid">
    <div class="full"><label for="k">Type</label><select id="k" name="kind">${options(KINDS.filter(([k]) => k !== 'adjustment' || isOwner()).map(([value, label]) => ({ value, label })), 'transfer')}</select></div>
    <div data-show="transfer exchange cost"><label for="fa">From account</label><select id="fa" name="fromAccountId">${options(money, preset)}</select></div>
    <div data-show="transfer exchange income capital opening"><label for="ta">To account</label><select id="ta" name="toAccountId">${options(money, '', { blank: 'Choose…' })}</select></div>
    <div data-show="adjustment"><label for="aa">Account</label><select id="aa" name="accountId">${options(all, preset)}</select></div>
    <div><label for="am">Amount <small id="am-cur"></small></label><input id="am" name="amount" inputmode="decimal" required><p class="hint" data-show="adjustment">Negative to reduce.</p></div>
    <div data-show="exchange"><label for="ar">Amount received</label><input id="ar" name="amountReceived" inputmode="decimal"></div>
    <div data-show="transfer exchange"><label for="fe">Fee (sender currency)</label><input id="fe" name="fee" inputmode="decimal" value="0"></div>
    <div data-show="cost"><label for="ca">Category</label><input id="ca" name="category" placeholder="e.g. Bank charges"></div>
    <div><label for="d">Date</label><input id="d" name="occurredOn" type="date" value="${today()}"></div><div><label for="r">Reference</label><input id="r" name="reference" maxlength="80"></div>
    <div class="full"><label for="n">Note</label><input id="n" name="note" maxlength="300"></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Record</button>` });
  const form = byId(d, 'f');
  const sync = () => {
    const kind = form.kind.value;
    $$('[data-show]', d).forEach(n => { const on = n.dataset.show.split(' ').includes(kind); n.classList.toggle('hidden', !on); n.querySelectorAll('select, input').forEach(i => { i.disabled = !on; }); });
    const acct = (kind === 'adjustment' ? all.find(a => a.value === form.accountId.value) : ['income', 'capital', 'opening'].includes(kind) ? money.find(a => a.value === form.toAccountId.value) : money.find(a => a.value === form.fromAccountId.value))?.account;
    byId(d, 'am-cur').textContent = acct ? `(${acct.currency})` : '';
  };
  form.addEventListener('change', sync); sync();
  onSubmit(form, async data => { await api('/api/movements', { method: 'POST', body: data }); done(); });
}
