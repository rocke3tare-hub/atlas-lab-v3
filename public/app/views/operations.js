import { api, html, mount, modal, closeModal, onSubmit, toast, showError, $, $$ } from '../../assets/ui.js';
import { fmt, pill, options, ctx, accountOptions } from '../common.js';

const money2 = v => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const outcomeOptions = market => Object.entries(ctx.me.outcomes).filter(([, o]) => market === 'three_way' || !o.threeWayOnly).map(([value, o]) => ({ value, label: o.label }));

export async function render(target, app, [operationId]) {
  if (operationId) return detail(target, app, operationId);
  const [ops, tree] = await Promise.all([api('/api/operations'), api('/api/structure')]);
  mount(target, html`<div class="page-head"><div><h1>Operations</h1><p>Plan stakes per event, check each account against its platform rules, then reserve, place and settle.</p></div>
    <button class="primary" type="button" id="new">New operation</button></div>
    <section class="card">${ops.length ? html`<div class="table-wrap"><table><thead><tr><th>Operation</th><th>Client</th><th>Events</th><th>Open bets</th><th>Status</th></tr></thead><tbody>
      ${ops.map(o => html`<tr class="clickable" data-op="${o.id}"><td><b>${o.name}</b><br><small>${o.created_at.slice(0, 10)}</small></td><td>${o.client_name}</td><td>${o.events}</td><td>${o.open_bets}</td><td>${pill(o.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No operations yet.</p>`}</section>`);
  $$('[data-op]', target).forEach(r => r.addEventListener('click', () => app.go(`operations/${r.dataset.op}`)));
  $('#new', target).addEventListener('click', () => {
    const d = modal({ title: 'New operation', body: html`<form id="f" class="form-grid"><div class="full"><label for="c">Client</label><select id="c" name="clientId">${options(tree.map(c => ({ value: c.id, label: c.name })), tree[0]?.id)}</select></div>
      <div class="full"><label for="n">Name</label><input id="n" name="name" required maxlength="100"></div><div class="full"><label for="no">Notes</label><textarea id="no" name="notes"></textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => { const op = await api('/api/operations', { method: 'POST', body: data }); closeModal(); app.go(`operations/${op.id}`); });
  });
}

async function detail(target, app, id) {
  const [op, tree] = await Promise.all([api(`/api/operations/${id}`), api('/api/structure')]);
  const accounts = accountOptions(tree.filter(c => c.id === op.client_id), a => a.kind === 'platform');
  const closed = op.status === 'closed';
  mount(target, html`<div class="page-head"><div><h1>${op.name}</h1><p>${pill(op.status)} ${op.notes || ''}</p></div>
      <div class="btn-row"><button type="button" id="back">All operations</button>${!closed ? html`<button type="button" id="add-event" class="primary">Add event</button>` : ''}
      ${op.status === 'planning' ? html`<button type="button" data-status="live">Go live</button>` : ''}${!closed ? html`<button type="button" data-status="closed">Close</button>` : ''}</div></div>
    ${op.events.length ? op.events.map(e => html`<section class="event-card" data-event="${e.id}">
      <div class="card-head"><div><h3>${e.name}</h3><small>${ctx.me.markets[e.market_type].label}${e.starts_at ? html` · ${new Date(e.starts_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</small></div>
        <div>${e.result ? pill('closed', `result: ${e.result === 'void' ? 'void' : ctx.me.scenarios[e.result]}`) : ''}</div></div>
      ${e.plan ? html`<div class="notice info">Plan (${e.plan.mode}, ${e.plan.currency}): stakes ${e.plan.input.map((o, i) => `${ctx.me.outcomes[o.type].label} ${money2(e.plan.stakes[i])}`).join(' · ')} · total ${money2(e.plan.totalStake)} · worst ${money2(e.plan.worstProfit)} · best ${money2(e.plan.bestProfit)}</div>` : ''}
      ${e.exposure.map(x => html`<div class="scenario-grid">${x.scenarios.map(s => html`<div class="scenario"><small>If ${ctx.me.scenarios[s.scenario]}</small><b class="${s.profit < 0 ? 'neg' : 'pos'}">${fmt(s.profit, x.currency, { sign: true })}</b><small>return ${fmt(s.grossReturn, x.currency)} on ${fmt(x.stake, x.currency)}</small></div>`)}</div>`)}
      ${e.bets.length ? html`<div class="table-wrap"><table><thead><tr><th>Account</th><th>Outcome</th><th class="num">Odds</th><th class="num">Stake</th><th>Status</th><th class="num">Payout</th><th></th></tr></thead><tbody>
        ${e.bets.map(b => html`<tr><td>${b.account_name}<br><small>${b.platform_name}</small></td><td>${ctx.me.outcomes[b.outcome].label}</td><td class="num">${(b.odds / 1000).toFixed(2)}</td>
          <td class="num">${fmt(b.stake, b.currency)}<br><small>${b.stake_type.replace('_', ' ')}</small></td><td>${pill(b.status)}${b.approval_note ? html`<br><small>Approved: ${b.approval_note}</small>` : ''}</td><td class="num">${b.payout != null ? fmt(b.payout, b.currency) : ''}</td>
          <td>${b.status === 'reserved' ? html`<div class="btn-row"><button type="button" data-place="${b.id}">Placed</button><button type="button" data-cancel="${b.id}">Cancel</button></div>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No bets yet.</p>`}
      ${!e.result && !closed ? html`<div class="btn-row"><button type="button" data-plan="${e.id}">Plan stakes</button><button type="button" data-bet="${e.id}">Add bet</button><button type="button" class="primary" data-settle="${e.id}">Enter result</button></div>` : ''}
    </section>`) : html`<p class="empty">Add the first event.</p>`}`);

  const reload = () => detail(target, app, id);
  const post = async (url, body, msg) => { try { await api(url, { method: 'POST', body }); toast(msg); reload(); } catch (error) { showError(error); } };
  $('#back', target).addEventListener('click', () => app.go('operations'));
  $$('[data-status]', target).forEach(b => b.addEventListener('click', async () => { try { await api(`/api/operations/${id}`, { method: 'PATCH', body: { status: b.dataset.status } }); reload(); } catch (error) { showError(error); } }));
  $$('[data-place]', target).forEach(b => b.addEventListener('click', () => post(`/api/bets/${b.dataset.place}/place`, {}, 'Bet marked as placed.')));
  $$('[data-cancel]', target).forEach(b => b.addEventListener('click', () => post(`/api/bets/${b.dataset.cancel}/cancel`, {}, 'Reservation cancelled.')));
  $('#add-event', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Add event', body: html`<form id="f" class="form-grid"><div class="full"><label for="n">Event</label><input id="n" name="name" required placeholder="Team 1 v Team 2"></div>
      <div><label for="m">Market</label><select id="m" name="marketType">${options(Object.entries(ctx.me.markets).map(([value, m]) => ({ value, label: m.label })), 'three_way')}</select></div><div><label for="s">Starts</label><input id="s" name="startsAt" type="datetime-local"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Add</button>` });
    onSubmit(d.querySelector('#f'), async data => { if (!data.startsAt) delete data.startsAt; await api(`/api/operations/${id}/events`, { method: 'POST', body: data }); closeModal(); reload(); });
  });
  $$('[data-settle]', target).forEach(b => b.addEventListener('click', () => {
    const e = op.events.find(x => x.id === b.dataset.settle);
    const results = [...ctx.me.markets[e.market_type].scenarios.map(s => ({ value: s, label: ctx.me.scenarios[s] })), { value: 'void', label: 'Void (all stakes returned)' }];
    const d = modal({ title: `Result · ${e.name}`, subtitle: 'Placed bets settle and payouts are posted. Unplaced reservations are cancelled.', body: html`<form id="f"><label for="r">Result</label><select id="r" name="result">${options(results, results[0].value)}</select></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Settle event</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/events/${e.id}/settle`, { method: 'POST', body: data }); closeModal(); toast('Event settled.'); reload(); });
  }));
  $$('[data-plan]', target).forEach(b => b.addEventListener('click', () => planner(op.events.find(x => x.id === b.dataset.plan), reload)));
  $$('[data-bet]', target).forEach(b => b.addEventListener('click', () => betForm(op.events.find(x => x.id === b.dataset.bet), accounts, reload)));
}

function planner(event, reload) {
  const outs = outcomeOptions(event.market_type);
  const defaults = event.plan?.input || (event.market_type === 'three_way' ? [{ type: 'team1_win', odds: 1.9 }, { type: 'draw', odds: 3.2 }, { type: 'team2_win', odds: 3.8 }] : [{ type: 'team1_win', odds: 1.9 }, { type: 'team2_win', odds: 1.9 }]);
  const row = o => html`<div class="outcome-row"><div><label>Outcome</label><select name="type">${options(outs, o.type)}</select></div><div><label>Odds</label><input name="odds" inputmode="decimal" value="${o.odds ?? ''}"></div>
    <div><label>Stake (manual / locked)</label><input name="stake" inputmode="decimal" value="${o.stake ?? ''}"></div><div><label>Min</label><input name="min" inputmode="decimal" value="${o.min ?? ''}"></div><div><label>Max</label><input name="max" inputmode="decimal" value="${o.max === Infinity || o.max == null ? '' : o.max}"></div>
    <div><label class="check"><input type="checkbox" name="locked" ${o.locked ? 'checked' : ''}> Lock</label><button type="button" class="icon-btn" data-remove aria-label="Remove outcome">−</button></div></div>`;
  const d = modal({ title: `Plan stakes · ${event.name}`, subtitle: 'Balanced mode maximises the worst-case result; nothing is reserved until you add bets.', wide: true, body: html`<form id="f">
    <div class="form-grid"><div><label for="mo">Mode</label><select id="mo" name="mode">${options([{ value: 'balanced', label: 'Balanced (place this capital)' }, { value: 'target', label: 'Target gross return' }, { value: 'manual', label: 'Manual stakes' }], event.plan?.mode || 'balanced')}</select></div>
      <div><label for="cu">Currency</label><select id="cu" name="currency">${options(ctx.me.currencies.map(c => ({ value: c, label: c })), event.plan?.currency || ctx.me.baseCurrency)}</select></div>
      <div><label for="ca">Capital</label><input id="ca" name="capital" inputmode="decimal" value="1000"></div><div><label for="tr">Target return</label><input id="tr" name="targetReturn" inputmode="decimal"></div>
      <div><label for="in">Rounding step</label><input id="in" name="increment" inputmode="decimal" value="0.01"></div></div>
    <h3>Outcomes</h3><div class="rows">${defaults.map(row)}</div><button type="button" data-add>Add outcome</button>
    <div id="plan-result" aria-live="polite"></div></form>`, footer: html`<button type="button" data-close>Close</button><button form="f" class="primary" type="submit">Calculate & save plan</button>` });
  d.addEventListener('click', e => {
    if (e.target.closest('[data-remove]')) e.target.closest('.outcome-row').remove();
    if (e.target.closest('[data-add]')) $('.rows', d).insertAdjacentHTML('beforeend', String(row({ type: outs[0].value })));
  });
  onSubmit(d.querySelector('#f'), async data => {
    const outcomes = $$('.outcome-row', d).map(r => ({ type: r.querySelector('[name=type]').value, odds: r.querySelector('[name=odds]').value, stake: r.querySelector('[name=stake]').value, min: r.querySelector('[name=min]').value, max: r.querySelector('[name=max]').value, locked: r.querySelector('[name=locked]').checked }));
    const plan = await api(`/api/events/${event.id}/plan`, { method: 'POST', body: { mode: data.mode, currency: data.currency, capital: data.capital, targetReturn: data.targetReturn, increment: data.increment, outcomes } });
    mount($('#plan-result', d), html`<div class="scenario-grid">${plan.input.map((o, i) => html`<div class="scenario"><small>${ctx.me.outcomes[o.type].label} @ ${o.odds}</small><b>${money2(plan.stakes[i])}</b></div>`)}</div>
      <div class="scenario-grid">${plan.scenarios.map(s => html`<div class="scenario"><small>If ${s.label}</small><b class="${s.profit < -1e-9 ? 'neg' : 'pos'}">${money2(s.profit)}</b><small>returns ${money2(s.grossReturn)}</small></div>`)}</div>
      <p class="hint">Total ${money2(plan.totalStake)} ${plan.currency} · guaranteed return ${plan.guaranteedReturnPercent.toFixed(2)}%${plan.bookPercent ? ` · bookmaker margin ${(plan.bookPercent - 100).toFixed(2)}%` : ''}${plan.arbitrage ? ' · arbitrage: every result profits' : ''}</p>
      ${plan.warnings.map(w => html`<p class="notice">${w}</p>`)}`);
    toast('Plan saved.');
    reload();
  });
}

function betForm(event, accounts, reload) {
  const outs = outcomeOptions(event.market_type);
  const planned = event.plan ? Object.fromEntries(event.plan.input.map((o, i) => [o.type, { odds: o.odds, stake: event.plan.stakes[i] }])) : {};
  const d = modal({ title: `Add bet · ${event.name}`, subtitle: 'Checks the account against its platform rules and available balance before reserving.', wide: true, body: html`<form id="f" class="form-grid">
    <div><label for="o">Outcome</label><select id="o" name="outcome">${options(outs, outs[0].value)}</select></div>
    <div><label for="t">Stake from</label><select id="t" name="stakeType">${options([{ value: 'cash', label: 'Cash balance' }, { value: 'bonus', label: 'Bonus balance' }, { value: 'free_bet', label: 'Free bet' }], 'cash')}</select></div>
    <div><label for="od">Odds</label><input id="od" name="odds" inputmode="decimal" required></div><div><label for="s">Stake</label><input id="s" name="stake" inputmode="decimal" required></div>
    <div class="full"><button type="button" id="check">Check accounts</button></div><div class="full" id="elig"></div>
    <div class="full"><label for="a">Account</label><select id="a" name="accountId">${options(accounts, '', { blank: 'Choose after checking…' })}</select></div>
    <div class="full"><label for="on">Owner approval note (platforms that require approval)</label><input id="on" name="overrideNote" maxlength="300"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Reserve bet</button>` });
  const form = d.querySelector('#f');
  const fill = () => { const p = planned[form.outcome.value]; if (p) { form.odds.value = p.odds; form.stake.value = p.stake.toFixed(2); } };
  form.outcome.addEventListener('change', fill); fill();
  d.querySelector('#check').addEventListener('click', async () => {
    try {
      const rows = await api(`/api/events/${event.id}/eligibility`, { method: 'POST', body: { outcome: form.outcome.value, odds: form.odds.value, stake: form.stake.value, stakeType: form.stakeType.value } });
      mount($('#elig', d), html`<div class="list">${rows.map(r => html`<div class="list-item"><div><b>${r.name}</b> <small>${r.platform} · available ${fmt(r.available, r.currency)} · max stake ${fmt(r.maxStake, r.currency)}</small>${r.reasons.length ? html`<br><small>${r.reasons.join(' ')}</small>` : ''}</div>
        <div>${pill(r.status === 'ok' ? 'approved' : r.status === 'review' ? 'pending' : 'rejected', r.status === 'ok' ? 'eligible' : r.status)} ${r.status !== 'blocked' ? html`<button type="button" data-pick="${r.accountId}">Use</button>` : ''}</div></div>`)}</div>`);
      $$('[data-pick]', d).forEach(b => b.addEventListener('click', () => { form.accountId.value = b.dataset.pick; }));
    } catch (error) { showError(error); }
  });
  onSubmit(form, async data => { await api(`/api/events/${event.id}/bets`, { method: 'POST', body: data }); closeModal(); toast('Bet reserved.'); reload(); });
}
