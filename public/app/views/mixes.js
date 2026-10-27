import { byId, api, html, mount, modal, closeModal, onSubmit, toast, showError, $, $$ } from '../../assets/ui.js';
import { pill, options, accountOptions } from '../common.js';

const n2 = v => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function render(target, app, [mixId]) {
  const [mixes, tree] = await Promise.all([api('/api/mixes'), api('/api/structure')]);
  const platformAccounts = accountOptions(tree, a => a.kind === 'platform' && a.status === 'active');
  if (mixId) return detail(target, app, mixes.find(m => m.id === mixId) || await api(`/api/mixes/${mixId}`), platformAccounts);
  mount(target, html`<div class="page-head"><div><h1>Accumulators</h1><p>Multi-leg tickets settled leg by leg, with free-bet valuation and hedges between legs.</p></div><button class="primary" type="button" id="new">New accumulator</button></div>
    <section class="card">${mixes.length ? html`<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Account</th><th class="num">Odds</th><th class="num">Potential</th><th>Status</th></tr></thead><tbody>
      ${mixes.map(m => html`<tr class="clickable" data-mix="${m.id}"><td><b>${m.title}</b><br><small>${m.mix.legs.length} legs</small></td><td>${m.accountName}</td><td class="num">${m.values.combinedOdds.toFixed(3)}</td><td class="num">${n2(m.values.potential)} ${m.currency}</td><td>${pill(m.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No accumulators yet.</p>`}</section>`);
  $$('[data-mix]', target).forEach(r => r.addEventListener('click', () => app.go(`mixes/${r.dataset.mix}`)));
  $('#new', target).addEventListener('click', () => {
    const d = modal({ title: 'New accumulator', body: html`<form id="f" class="form-grid">
      <div class="full"><label for="t">Title</label><input id="t" name="title" required></div>
      <div class="full"><label for="a">Platform account</label><select id="a" name="accountId">${options(platformAccounts, platformAccounts[0]?.value)}</select></div>
      <div><label for="c">Cash stake</label><input id="c" name="cashStake" inputmode="decimal" value="0"></div><div><label for="b">Bonus stake</label><input id="b" name="bonusStake" inputmode="decimal" value="0"></div>
      <div><label for="fb">Free-bet stake</label><input id="fb" name="freeBetStake" inputmode="decimal" value="0"></div><div><label for="g">Minimum minutes between legs</label><input id="g" name="minimumGapMinutes" inputmode="numeric" value="15"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(byId(d, 'f'), async data => { const m = await api('/api/mixes', { method: 'POST', body: data }); closeModal(); app.go(`mixes/${m.id}`); });
  });
}

function detail(target, app, m, platformAccounts) {
  const v = m.values; const p = m.position; const c = m.currency;
  const draft = m.status === 'draft';
  mount(target, html`<div class="page-head"><div><h1>${m.title}</h1><p>${pill(m.status)} on ${m.accountName}</p></div>
      <div class="btn-row"><button type="button" id="back">All accumulators</button>${draft ? html`<button type="button" id="leg">Add leg</button><button type="button" class="primary" id="lock">Lock & place</button>` : ''}${m.active ? html`<button type="button" id="hedge">Add hedge</button><button type="button" id="suggest">Suggest hedge</button>` : ''}</div></div>
    <div class="metrics"><div class="metric"><span>Combined odds</span><strong>${v.combinedOdds.toFixed(3)}</strong></div>
      <div class="metric"><span>Stakes</span><strong>${n2(v.totalStake)}</strong><small>cash ${n2(m.mix.cashStake)} · bonus ${n2(m.mix.bonusStake)} · free bet ${n2(m.mix.freeBetStake)}</small></div>
      <div class="metric"><span>Ticket value now</span><strong>${n2(v.potential)}</strong><small>true value ${n2(v.truePotential)} (free bet pays winnings only)</small></div>
      ${!draft ? html`<div class="metric"><span>If active leg wins / loses</span><strong>${n2(p.ifWins)} / ${n2(p.ifLoses)}</strong><small>worst ${n2(p.worst)} · best ${n2(p.best)} ${c}</small></div>` : ''}
      ${m.settlement ? html`<div class="metric"><span>Settled net</span><strong class="${m.settlement.net < 0 ? 'neg' : 'pos'}">${n2(m.settlement.net)}</strong><small>returned ${n2(m.settlement.returned)} on ${n2(m.settlement.spent)}</small></div>` : ''}</div>
    <section class="card"><h3>Legs (settle in order)</h3>${m.mix.legs.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Event</th><th>Selection</th><th class="num">Odds</th><th>Settles</th><th>Status</th><th></th></tr></thead><tbody>
      ${m.mix.legs.slice().sort((a, b) => a.settlesAt.localeCompare(b.settlesAt)).map((l, i) => html`<tr><td>${i + 1}</td><td>${l.event}<br><small>${l.market}</small></td><td>${l.selection}</td><td class="num">${l.odds.toFixed(2)}</td><td>${l.settlesAt.replace('T', ' ')}</td><td>${pill(l.status)}</td>
        <td>${m.active?.id === l.id ? html`<div class="btn-row"><button type="button" data-result="won" data-leg="${l.id}">Won</button><button type="button" data-result="lost" data-leg="${l.id}">Lost</button><button type="button" data-result="void" data-leg="${l.id}">Void</button></div>` : draft ? html`<button type="button" data-remove="${l.id}">Remove</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Add at least two legs.</p>`}
      ${m.gaps.map(g => g.status !== 'sufficient' ? html`<p class="notice">${g.minutes} minutes between two legs (${g.status}) — little time to hedge.</p>` : '')}</section>
    ${m.mix.hedges.length ? html`<section class="card"><h3>Hedges</h3>${m.mix.hedges.map(h => html`<div class="line"><span>${h.side === 'against' ? 'Against' : 'Backing'} the selection · ${n2(h.stake)} @ ${h.odds.toFixed(2)}</span><b>${pill(h.status)} ${h.payout ? n2(h.payout) : ''}</b></div>`)}</section>` : ''}`);
  const refresh = updated => detail(target, app, updated, platformAccounts);
  const send = async (url, body, msg, method = 'POST') => { try { refresh(await api(url, { method, body: { ...body, expectedVersion: m.version } })); if (msg) toast(msg); } catch (error) { showError(error); } };
  $('#back', target).addEventListener('click', () => app.go('mixes'));
  $$('[data-result]', target).forEach(b => b.addEventListener('click', () => send(`/api/mixes/${m.id}/settle`, { legId: b.dataset.leg, result: b.dataset.result }, 'Leg settled.')));
  $$('[data-remove]', target).forEach(b => b.addEventListener('click', async () => { try { refresh(await api(`/api/mixes/${m.id}/legs/${b.dataset.remove}`, { method: 'DELETE' })); } catch (error) { showError(error); } }));
  $('#lock', target)?.addEventListener('click', () => {
    const tight = m.gaps.some(g => g.status === 'insufficient');
    if (!tight) return send(`/api/mixes/${m.id}/lock`, {}, 'Accumulator locked; cash stake recorded.');
    const d = modal({ title: 'Legs settle close together', subtitle: 'Only the owner can lock with an override.', body: html`<form id="f"><label for="r">Override reason</label><input id="r" name="overrideReason" required></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Lock anyway</button>` });
    onSubmit(byId(d, 'f'), async data => { closeModal(); await send(`/api/mixes/${m.id}/lock`, data, 'Accumulator locked.'); });
  });
  $('#leg', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Add leg', body: html`<form id="f" class="form-grid"><div class="full"><label for="e">Event</label><input id="e" name="event" required></div>
      <div><label for="mk">Market</label><input id="mk" name="market" value="Match winner" required></div><div><label for="se">Selection</label><input id="se" name="selection" required></div>
      <div><label for="o">Odds</label><input id="o" name="odds" inputmode="decimal" required></div><div></div>
      <div><label for="st">Starts</label><input id="st" name="startsAt" type="datetime-local" required></div><div><label for="sa">Settles</label><input id="sa" name="settlesAt" type="datetime-local" required></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Add leg</button>` });
    onSubmit(byId(d, 'f'), async data => { const updated = await api(`/api/mixes/${m.id}/legs`, { method: 'POST', body: { ...data, expectedVersion: m.version } }); closeModal(); refresh(updated); });
  });
  $('#hedge', target)?.addEventListener('click', () => hedgeForm(m, platformAccounts, refresh));
  $('#suggest', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Suggest a hedge', subtitle: 'Balances the two outcomes of the active leg. Nothing is placed.', body: html`<form id="f"><label for="o">Available odds</label><input id="o" name="odds" inputmode="decimal" required></form><div id="s"></div>`, footer: html`<button type="button" data-close>Close</button><button form="f" class="primary" type="submit">Suggest</button>` });
    onSubmit(byId(d, 'f'), async data => { const s = await api(`/api/mixes/${m.id}/suggestion?odds=${encodeURIComponent(data.odds)}`); mount(byId(d, 's'), s ? html`<p class="notice info">Stake <b>${n2(s.stake)} ${c}</b> ${s.side === 'against' ? 'against' : 'on'} the selection at ${s.odds} (returns ${n2(s.expectedReturn)}).</p>` : html`<p class="muted">No hedge needed.</p>`); });
  });
}

function hedgeForm(m, platformAccounts, refresh) {
  const same = platformAccounts.filter(a => a.client.id === m.clientId && a.account.currency === m.currency);
  const d = modal({ title: 'Add hedge', subtitle: 'The stake leaves the hedge account now; any payout arrives when the leg settles.', body: html`<form id="f" class="form-grid">
    <div class="full"><label for="a">Hedge account</label><select id="a" name="accountId">${options(same, same[0]?.value)}</select></div>
    <div><label for="sd">Side</label><select id="sd" name="side">${options([{ value: 'against', label: 'Against the selection' }, { value: 'selection', label: 'Backing the selection' }], 'against')}</select></div>
    <div><label for="o">Odds</label><input id="o" name="odds" inputmode="decimal" required></div><div><label for="s">Stake</label><input id="s" name="stake" inputmode="decimal" required></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Record hedge</button>` });
  onSubmit(byId(d, 'f'), async data => { const updated = await api(`/api/mixes/${m.id}/hedges`, { method: 'POST', body: { ...data, expectedVersion: m.version } }); closeModal(); refresh(updated); });
}
