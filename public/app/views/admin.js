import { api, html, mount, modal, closeModal, onSubmit, toast, showError, $, $$ } from '../../assets/ui.js';
import { fmt, pill, options, ctx, isOwner, canOperate, checked } from '../common.js';

export async function render(target, app) {
  const owner = isOwner();
  const [platforms, users, clients, audit] = await Promise.all([canOperate() ? api('/api/platforms') : [], owner ? api('/api/users') : [], owner ? api('/api/clients') : [], owner ? api('/api/audit?limit=100') : []]);
  const odds = v => (v ? (v / 1000).toFixed(2) : '—');
  mount(target, html`<div class="page-head"><div><h1>${canOperate() ? 'Platforms & settings' : 'Settings'}</h1><p>${canOperate() ? 'Platform rules are versioned: a change applies from now on and each bet keeps the rule it was checked against.' : 'Your account.'}</p></div>
      ${owner ? html`<div class="btn-row"><button type="button" id="new-platform">New platform</button><button type="button" class="primary" id="new-user">New user</button></div>` : ''}</div>
    ${canOperate() ? html`<section class="card"><h3>Platforms</h3>${platforms.length ? html`<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Odds range</th><th class="num">Max stake</th><th class="num">Max payout</th><th>Turnover</th><th>Per event</th><th></th></tr></thead><tbody>
      ${platforms.map(p => html`<tr><td><b>${p.name}</b> <small>${p.code} · ${p.currency}</small> ${p.status !== 'active' ? pill(p.status) : ''}<br><small>${p.rule.notes || ''}${p.history.length > 1 ? ` · ${p.history.length} rule versions` : ''}</small></td>
        <td>${odds(p.rule.minOdds)} – ${p.rule.maxOdds ? odds(p.rule.maxOdds) : 'no max'}</td><td class="num">${p.rule.maxStake ? fmt(p.rule.maxStake, p.currency) : '—'}</td><td class="num">${p.rule.maxPayout ? fmt(p.rule.maxPayout, p.currency) : '—'}</td>
        <td>${p.rule.turnoverBp / 100}% of ${p.rule.turnoverBase.replaceAll('_', ' ')}</td><td>${p.rule.maxOutcomesPerEvent} outcome(s)${p.rule.multipleAccountsPerOutcome ? ' · shared outcomes' : ''}${p.rule.manualApproval ? ' · owner approval' : ''}</td>
        <td>${owner ? html`<button type="button" data-rule="${p.id}">New rule version</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No platforms yet.</p>`}</section>` : ''}
    ${owner ? html`<section class="card"><h3>Users</h3><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => html`<tr><td><b>${u.display_name}</b><br><small>${u.email}</small></td><td>${u.role}</td><td>${u.role === 'owner' ? 'All clients' : u.role === 'shareholder' ? u.client_name : (u.clients.map(id => clients.find(c => c.id === id)?.name).filter(Boolean).join(', ') || 'No clients yet')}</td><td>${pill(u.status)}</td>
        <td><div class="btn-row">${u.role === 'admin' ? html`<button type="button" data-assign="${u.id}">Clients</button>` : ''}${u.id !== ctx.me.user.userId ? html`<button type="button" data-toggle="${u.id}">${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button>` : ''}</div></td></tr>`)}</tbody></table></div></section>` : ''}
    <div class="grid two"><section class="card"><h3>Your password</h3><form id="pw" class="form-grid">
      <div class="full"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" autocomplete="current-password" required></div>
      <div class="full"><label for="np">New password</label><input id="np" name="newPassword" type="password" autocomplete="new-password" minlength="10" required></div>
      <div class="full"><button type="submit">Change password</button></div></form></section>
      <section class="card"><h3>Export</h3><p class="muted">Movements and profit & loss for everything you can see.</p><div class="btn-row"><a class="btn primary" href="/api/export?format=xlsx">Excel workbook</a><a class="btn" href="/api/export?format=csv">Movements CSV</a></div></section></div>
    ${owner ? html`<section class="card"><h3>Recent audit events</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Reason</th></tr></thead><tbody>
      ${audit.map(a => html`<tr><td>${a.created_at.slice(0, 16).replace('T', ' ')}</td><td>${a.actor || 'system'}</td><td>${a.action}</td><td>${a.reason || ''}</td></tr>`)}</tbody></table></div></section>` : ''}`);

  onSubmit($('#pw', target), async data => { await api('/api/auth/password', { method: 'POST', body: data }); toast('Password changed. Sign in again.'); setTimeout(() => location.reload(), 800); });
  const done = msg => { closeModal(); toast(msg); render(target, app); };
  $('#new-platform', target)?.addEventListener('click', () => {
    const d = modal({ title: 'New platform', body: html`<form id="f" class="form-grid"><div><label for="n">Name</label><input id="n" name="name" required></div><div><label for="c">Code</label><input id="c" name="code" required maxlength="16"></div>
      <div class="full"><label for="cu">Currency</label><select id="cu" name="currency">${options(ctx.me.currencies.map(c => ({ value: c, label: c })), ctx.me.baseCurrency)}</select></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/platforms', { method: 'POST', body: data }); done('Platform created. Add its rules next.'); });
  });
  $$('[data-rule]', target).forEach(b => b.addEventListener('click', () => {
    const p = platforms.find(x => x.id === b.dataset.rule); const r = p.rule;
    const money = v => (v ? (v / 10 ** (ctx.me.currencyDecimals[p.currency] ?? 2)).toString() : '');
    const d = modal({ title: `Rules · ${p.name}`, subtitle: 'Creates a new version from today (or the date you pick). History is kept.', wide: true, body: html`<form id="f" class="form-grid">
      <div><label for="mi">Minimum odds</label><input id="mi" name="minOdds" inputmode="decimal" value="${(r.minOdds / 1000).toFixed(2)}"></div><div><label for="ma">Maximum odds (blank = none)</label><input id="ma" name="maxOdds" inputmode="decimal" value="${r.maxOdds ? (r.maxOdds / 1000).toFixed(2) : ''}"></div>
      <div><label for="ms">Max stake (blank = none)</label><input id="ms" name="maxStake" inputmode="decimal" value="${money(r.maxStake)}"></div><div><label for="mp">Max payout (blank = none)</label><input id="mp" name="maxPayout" inputmode="decimal" value="${money(r.maxPayout)}"></div>
      <div><label for="tp">Turnover %</label><input id="tp" name="turnoverPercent" inputmode="decimal" value="${r.turnoverBp / 100}"></div>
      <div><label for="tb">Turnover base</label><select id="tb" name="turnoverBase">${options([{ value: 'deposit', label: 'Deposits' }, { value: 'bonus', label: 'Bonus credited' }, { value: 'deposit_plus_bonus', label: 'Deposits + bonus' }], r.turnoverBase)}</select></div>
      <div><label for="mo">Outcomes per account per event</label><input id="mo" name="maxOutcomesPerEvent" inputmode="numeric" value="${r.maxOutcomesPerEvent}"></div><div><label for="ef">Effective from</label><input id="ef" name="effectiveFrom" type="date"></div>
      <label class="check"><input type="checkbox" name="multipleAccountsPerOutcome" ${checked(r.multipleAccountsPerOutcome)}> Several accounts may back the same outcome</label>
      <label class="check"><input type="checkbox" name="manualApproval" ${checked(r.manualApproval)}> Every stake needs owner approval</label>
      <div class="full"><label for="no">Notes</label><textarea id="no" name="notes">${r.notes || ''}</textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save new version</button>` });
    onSubmit(d.querySelector('#f'), async data => { if (!data.effectiveFrom) delete data.effectiveFrom; await api(`/api/platforms/${p.id}/rules`, { method: 'POST', body: data }); done('Rule version saved.'); });
  }));
  $('#new-user', target)?.addEventListener('click', () => {
    const d = modal({ title: 'New user', subtitle: 'A one-time password is shown once.', body: html`<form id="f" class="form-grid">
      <div><label for="n">Name</label><input id="n" name="displayName" required></div><div><label for="e">Email</label><input id="e" name="email" type="email" required></div>
      <div><label for="r">Role</label><select id="r" name="role">${options([{ value: 'admin', label: 'Admin (operates assigned clients)' }, { value: 'shareholder', label: 'Shareholder (reads own client)' }, { value: 'owner', label: 'Owner (everything)' }], 'admin')}</select></div>
      <div><label for="c">Client (shareholders)</label><select id="c" name="clientId">${options(clients.map(c => ({ value: c.id, label: c.name })), '', { blank: '—' })}</select></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => {
      if (data.role !== 'shareholder') delete data.clientId;
      const r = await api('/api/users', { method: 'POST', body: data });
      closeModal();
      modal({ title: 'User created', body: html`<p>Share privately; it is not shown again.</p><div class="line"><span>Email</span><b>${r.email}</b></div><div class="line"><span>Temporary password</span><b>${r.temporaryPassword}</b></div>`, footer: html`<button type="button" class="primary" data-close>Done</button>` });
      render(target, app);
    });
  });
  $$('[data-assign]', target).forEach(b => b.addEventListener('click', () => {
    const u = users.find(x => x.id === b.dataset.assign);
    const d = modal({ title: `Clients for ${u.display_name}`, body: html`<form id="f">${clients.map(c => html`<label class="check"><input type="checkbox" name="c_${c.id}" ${checked(u.clients.includes(c.id))}> ${c.name}</label>`)}</form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/users/${u.id}/clients`, { method: 'PUT', body: { clientIds: Object.entries(data).filter(([, v]) => v).map(([k]) => k.slice(2)) } }); done('Access updated.'); });
  }));
  $$('[data-toggle]', target).forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id === b.dataset.toggle);
    try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'suspended' : 'active' } }); render(target, app); } catch (error) { showError(error); }
  }));
}
