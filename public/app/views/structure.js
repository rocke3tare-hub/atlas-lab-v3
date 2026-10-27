import { api, html, mount, modal, closeModal, onSubmit, toast, $, $$ } from '../../assets/ui.js';
import { fmt, pill, options, ctx, isOwner, canOperate, toInput, today } from '../common.js';

const cur = () => ctx.me.currencies.map(c => ({ value: c, label: c }));
let tree = [];

export async function render(target, app) {
  const [data, platforms] = await Promise.all([api('/api/structure'), canOperate() ? api('/api/platforms') : []]);
  tree = data;
  mount(target, html`<div class="page-head"><div><h1>Clients & accounts</h1><p>Client → holders → wallets, banks and platform accounts. Balances are calculated from recorded movements.</p></div>
      <div class="btn-row">${isOwner() ? html`<button class="primary" type="button" id="new-client">New client</button>` : ''}${canOperate() ? html`<button type="button" id="new-holder">New holder</button>` : ''}</div></div>
    ${tree.length ? tree.map(c => html`<section class="card tree-client">
      <div class="card-head"><div><h3>${c.name} <small>${c.code}</small> ${pill(c.status)}</h3>
        <small>${c.shareholder_id ? html`Capital ${fmt(c.capital, c.currency)} · allocated ${fmt(c.allocated, c.currency)} · unallocated ${fmt(c.unallocated, c.currency)} · profit share ${(c.profit_share_bp / 100).toFixed(2)}%` : 'No shareholder profile yet'}</small></div>
        <div class="btn-row">${isOwner() ? html`<button type="button" data-shareholder="${c.id}">Shareholder profile</button><button type="button" data-edit-client="${c.id}">Edit</button>` : ''}</div></div>
      ${c.holders.length ? c.holders.map(h => html`<div class="tree-holder"><div class="card-head"><div><b>${h.name}</b> <small>${h.code} · allocated ${fmt(h.allocated_capital, c.currency)}</small> ${h.status !== 'active' ? pill(h.status) : ''}</div>
          ${canOperate() ? html`<div class="btn-row"><button type="button" data-add-account="${h.id}">Add account</button><button type="button" data-edit-holder="${h.id}">Edit</button></div>` : ''}</div>
        <div class="acct-grid">${h.accounts.map(a => html`<div class="acct"><small>${a.kind === 'platform' ? a.platformName : a.kind} · ${a.code}</small><b>${a.name}</b>
          <b class="amount">${fmt(a.balance, a.currency)}</b>
          ${a.kind === 'platform' ? html`<small>Available ${fmt(a.available, a.currency)}${a.reserved ? html` · reserved ${fmt(a.reserved, a.currency)}` : ''}${a.pendingWithdrawals ? html` · withdrawing ${fmt(a.pendingWithdrawals, a.currency)}` : ''}</small>
            ${a.bonus || a.freeBet ? html`<small>Bonus ${fmt(a.bonus, a.currency)} · free bets ${fmt(a.freeBet, a.currency)}</small>` : ''}
            ${a.turnover.required ? html`<small>Turnover ${fmt(a.turnover.completed, a.currency)} / ${fmt(a.turnover.required, a.currency)}</small><div class="progress"><i data-width="${a.turnover.percent}"></i></div>` : ''}
            <div>${pill(a.readiness.state)} <small>${a.readiness.reason}</small></div>` : ''}
          ${a.status !== 'active' || a.kycStatus !== 'verified' ? html`<div>${a.status !== 'active' ? pill(a.status) : ''} ${a.kycStatus !== 'verified' ? pill('pending', `KYC ${a.kycStatus}`) : ''}</div>` : ''}
          ${canOperate() ? html`<div class="btn-row">${a.kind === 'platform' ? html`<button type="button" data-fund="${a.id}">Fund</button><button type="button" data-withdraw="${a.id}">Withdraw</button><button type="button" data-bonus="${a.id}">Bonus</button>` : html`<button type="button" data-move="${a.id}">Move money</button>`}<button type="button" data-edit-account="${a.id}">Edit</button></div>` : ''}
        </div>`)}${h.accounts.length ? '' : html`<p class="muted">No accounts yet.</p>`}</div></div>`) : html`<p class="muted">No holders yet.</p>`}
    </section>`) : html`<p class="empty">No clients yet.</p>`}`);
  $$('[data-width]', target).forEach(b => { b.style.width = `${b.dataset.width}%`; });

  const done = msg => { closeModal(); toast(msg); render(target, app); };
  const find = id => tree.flatMap(c => c.holders.flatMap(h => h.accounts.map(a => ({ a, h, c })))).find(x => x.a.id === id);
  const holderOf = id => tree.flatMap(c => c.holders.map(h => ({ h, c }))).find(x => x.h.id === id);

  $('#new-client', target)?.addEventListener('click', () => clientForm(null, done));
  $$('[data-edit-client]', target).forEach(b => b.addEventListener('click', () => clientForm(tree.find(c => c.id === b.dataset.editClient), done)));
  $$('[data-shareholder]', target).forEach(b => b.addEventListener('click', () => {
    const c = tree.find(x => x.id === b.dataset.shareholder);
    const d = modal({ title: `Shareholder · ${c.name}`, subtitle: 'Investment and the share of attributed profit paid to this investor.', body: html`<form id="f" class="form-grid">
      <div><label for="inv">Investment</label><input id="inv" name="investment" inputmode="decimal" required value="${c.shareholder_id ? toInput(c.investment, c.currency) : ''}"></div>
      <div><label for="cur">Currency</label><select id="cur" name="currency">${options(cur(), c.currency || ctx.me.baseCurrency)}</select></div>
      <div><label for="ps">Profit share %</label><input id="ps" name="profitSharePercent" inputmode="decimal" required value="${c.shareholder_id ? c.profit_share_bp / 100 : '40'}"></div>
      <div><label for="on">Invested on</label><input id="on" name="investedOn" type="date" value="${today()}"></div>
      <div class="full"><label for="st">Status</label><select id="st" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused (excluded from distribution)' }], c.shareholder_status || 'active')}</select></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/clients/${c.id}/shareholder`, { method: 'PUT', body: data }); done('Shareholder saved.'); });
  }));
  $('#new-holder', target)?.addEventListener('click', () => holderForm(null, done));
  $$('[data-edit-holder]', target).forEach(b => b.addEventListener('click', () => holderForm(holderOf(b.dataset.editHolder), done)));
  $$('[data-add-account]', target).forEach(b => b.addEventListener('click', () => {
    const { h } = holderOf(b.dataset.addAccount);
    const d = modal({ title: `New account · ${h.name}`, body: html`<form id="f" class="form-grid">
      <div><label for="k">Type</label><select id="k" name="kind">${options([{ value: 'wallet', label: 'Wallet' }, { value: 'bank', label: 'Bank' }, { value: 'platform', label: 'Platform account' }], 'platform')}</select></div>
      <div><label for="pl">Platform</label><select id="pl" name="platformId">${options(platforms.map(p => ({ value: p.id, label: `${p.name} (${p.currency})` })), '', { blank: '—' })}</select></div>
      <div><label for="cu">Currency (wallet/bank)</label><select id="cu" name="currency">${options(cur(), ctx.me.baseCurrency)}</select></div>
      <div><label for="co">Code</label><input id="co" name="code" required maxlength="16" placeholder="${h.code}-X"></div>
      <div><label for="n">Name (optional)</label><input id="n" name="name" maxlength="80"></div><div><label for="u">Username on platform</label><input id="u" name="username" maxlength="80"></div>
      <div class="full"><label for="ky">Identity verification</label><select id="ky" name="kycStatus">${options([{ value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }], 'verified')}</select></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => { if (data.kind !== 'platform') delete data.platformId; await api('/api/accounts', { method: 'POST', body: { ...data, holderId: h.id } }); done('Account created.'); });
  }));
  $$('[data-edit-account]', target).forEach(b => b.addEventListener('click', () => {
    const { a } = find(b.dataset.editAccount);
    const d = modal({ title: `Edit · ${a.name}`, body: html`<form id="f" class="form-grid">
      <div class="full"><label for="n">Name</label><input id="n" name="name" value="${a.name}" required></div>
      ${a.kind === 'platform' ? html`<div class="full"><label for="u">Username</label><input id="u" name="username" value="${a.username || ''}"></div>` : ''}
      <div><label for="s">Status</label><select id="s" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'closed', label: 'Closed' }], a.status)}</select></div>
      <div><label for="k">Verification</label><select id="k" name="kycStatus">${options([{ value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }], a.kycStatus)}</select></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: data }); done('Account updated.'); });
  }));
  $$('[data-fund]', target).forEach(b => b.addEventListener('click', () => {
    const { a, h } = find(b.dataset.fund);
    const sources = h.accounts.filter(x => x.kind !== 'platform' && x.currency === a.currency);
    const d = modal({ title: `Fund ${a.name}`, subtitle: 'Money moves from the same holder’s wallet or bank.', body: html`<form id="f" class="form-grid">
      <div class="full"><label for="s">From</label><select id="s" name="fromAccountId">${options(sources.map(x => ({ value: x.id, label: `${x.name} · ${fmt(x.available, x.currency)}` })), sources[0]?.id)}</select></div>
      <div><label for="am">Amount (${a.currency})</label><input id="am" name="amount" inputmode="decimal" required></div><div><label for="fe">Fee</label><input id="fe" name="fee" inputmode="decimal" value="0"></div>
      <div><label for="d">Date</label><input id="d" name="occurredOn" type="date" value="${today()}"></div><div><label for="r">Reference</label><input id="r" name="reference"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Record funding</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/fundings', { method: 'POST', body: { ...data, platformAccountId: a.id } }); done('Funding recorded.'); });
  }));
  $$('[data-withdraw]', target).forEach(b => b.addEventListener('click', () => {
    const { a, h } = find(b.dataset.withdraw);
    const dests = h.accounts.filter(x => x.kind !== 'platform' && x.currency === a.currency);
    const d = modal({ title: `Withdraw from ${a.name}`, subtitle: `Available ${fmt(a.available, a.currency)}. Money moves when you confirm arrival.`, body: html`<form id="f" class="form-grid">
      <div class="full"><label for="t">To</label><select id="t" name="destinationAccountId">${options(dests.map(x => ({ value: x.id, label: x.name })), dests[0]?.id)}</select></div>
      <div><label for="am">Amount</label><input id="am" name="amount" inputmode="decimal" required></div><div><label for="rq">Requested on</label><input id="rq" name="requestedOn" type="date" value="${today()}"></div>
      <div class="full"><label for="ex">Expected arrival</label><input id="ex" name="expectedOn" type="date"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Request withdrawal</button>` });
    onSubmit(d.querySelector('#f'), async data => { if (!data.expectedOn) delete data.expectedOn; await api('/api/withdrawals', { method: 'POST', body: { ...data, platformAccountId: a.id } }); done('Withdrawal requested.'); });
  }));
  $$('[data-bonus]', target).forEach(b => b.addEventListener('click', () => {
    const { a } = find(b.dataset.bonus);
    const d = modal({ title: `Credit bonus · ${a.name}`, body: html`<form id="f" class="form-grid">
      <div><label for="k">Type</label><select id="k" name="kind">${options([{ value: 'bonus', label: 'Bonus money' }, { value: 'free_bet', label: 'Free bet' }], 'free_bet')}</select></div>
      <div><label for="am">Amount (${a.currency})</label><input id="am" name="amount" inputmode="decimal" required></div><div class="full"><label for="n">Note</label><input id="n" name="note"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Credit</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/bonuses', { method: 'POST', body: { ...data, accountId: a.id } }); done('Bonus credited.'); });
  }));
  $$('[data-move]', target).forEach(b => b.addEventListener('click', () => app.go(`money/new/${b.dataset.move}`)));
}

function clientForm(c, done) {
  const d = modal({ title: c ? `Edit ${c.name}` : 'New client', body: html`<form id="f" class="form-grid">
    <div><label for="n">Name</label><input id="n" name="name" required value="${c?.name || ''}"></div><div><label for="c">Code</label><input id="c" name="code" required maxlength="16" value="${c?.code || ''}"></div>
    <div><label for="s">Status</label><select id="s" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'closed', label: 'Closed' }], c?.status || 'active')}</select></div>
    <div class="full"><label for="no">Note</label><textarea id="no" name="note">${c?.note || ''}</textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
  onSubmit(d.querySelector('#f'), async data => { await api(c ? `/api/clients/${c.id}` : '/api/clients', { method: c ? 'PATCH' : 'POST', body: data }); done('Client saved.'); });
}

function holderForm(existing, done) {
  const h = existing?.h; const c = existing?.c;
  const d = modal({ title: h ? `Edit ${h.name}` : 'New holder', subtitle: 'A person who holds wallets, banks and platform accounts for a client.', body: html`<form id="f" class="form-grid">
    <div class="full"><label for="cl">Client</label><select id="cl" name="clientId" ${h ? 'disabled' : ''}>${options(tree.map(x => ({ value: x.id, label: `${x.name} · unallocated ${x.shareholder_id ? fmt(x.unallocated, x.currency) : 'n/a'}` })), c?.id || tree[0]?.id)}</select></div>
    <div><label for="n">Name</label><input id="n" name="name" required value="${h?.name || ''}"></div><div><label for="co">Code</label><input id="co" name="code" required maxlength="16" value="${h?.code || ''}"></div>
    <div><label for="al">Allocated capital</label><input id="al" name="allocatedCapital" inputmode="decimal" value="${h ? toInput(h.allocated_capital, c.currency) : '0'}"></div>
    <div><label for="s">Status</label><select id="s" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }], h?.status || 'active')}</select></div>
    <div class="full"><label for="no">Note</label><input id="no" name="note" value="${h?.note || ''}"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
  onSubmit(d.querySelector('#f'), async data => { await api(h ? `/api/holders/${h.id}` : '/api/holders', { method: h ? 'PATCH' : 'POST', body: { ...data, clientId: c?.id || data.clientId } }); done('Holder saved.'); });
}
