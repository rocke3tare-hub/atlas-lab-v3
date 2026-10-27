import { api, html, mount } from '../../assets/ui.js';
import { fmt, signed, ctx } from '../common.js';

export async function render(target) {
  const d = await api('/api/dashboard');
  const role = ctx.me.user.role;
  mount(target, html`<div class="page-head"><div><h1>Dashboard</h1><p>${role === 'shareholder' ? 'Your capital and results.' : 'Balances, results and open work across your clients.'}</p></div></div>
    <div class="metrics">
      ${d.profitAndLoss.map(p => html`<div class="metric"><span>Net result · ${p.currency}</span><strong>${signed(p.net, p.currency)}</strong><small>gains ${fmt(p.gains, p.currency)} · losses ${fmt(p.losses, p.currency)} · fees ${fmt(p.fees, p.currency)}</small></div>`)}
      <div class="metric ${d.withdrawalIssues ? 'warn' : ''}"><span>Withdrawals in progress</span><strong>${d.openWithdrawals}</strong><small>${d.withdrawalIssues} delayed or blocked</small></div>
      ${d.openTasks != null ? html`<div class="metric ${d.overdueTasks ? 'warn' : ''}"><span>Open tasks</span><strong>${d.openTasks}</strong><small>${d.overdueTasks || 0} overdue</small></div>` : ''}
    </div>
    <section class="card"><h3>Balances by currency</h3>${d.balances.length ? html`<div class="table-wrap"><table><thead><tr><th>Currency</th><th class="num">Wallets</th><th class="num">Banks</th><th class="num">On platforms</th><th class="num">Reserved for bets</th><th class="num">Withdrawals pending</th><th class="num">Bonus</th><th class="num">Free bets</th></tr></thead><tbody>
      ${d.balances.map(b => html`<tr><td><b>${b.currency}</b></td><td class="num">${fmt(b.wallet, b.currency)}</td><td class="num">${fmt(b.bank, b.currency)}</td><td class="num">${fmt(b.platform, b.currency)}</td><td class="num">${fmt(b.reserved, b.currency)}</td><td class="num">${fmt(b.pendingWithdrawals, b.currency)}</td><td class="num">${fmt(b.bonus, b.currency)}</td><td class="num">${fmt(b.freeBet, b.currency)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No accounts yet.</p>`}</section>`);
}
