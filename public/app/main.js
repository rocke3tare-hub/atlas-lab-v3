import { api, html, raw, mount, $, $$, toast, showError, onSubmit, initLanguage, setLanguage } from '../assets/ui.js';
import { ctx } from './common.js';
import * as dashboard from './views/dashboard.js';
import * as structure from './views/structure.js';
import * as money from './views/money.js';
import * as operations from './views/operations.js';
import * as mixes from './views/mixes.js';
import * as withdrawals from './views/withdrawals.js';
import * as shareholders from './views/shareholders.js';
import * as work from './views/work.js';
import * as admin from './views/admin.js';

// Views per role. The API enforces the same rules; hiding links is convenience only.
const VIEWS = [
  { key: 'dashboard', label: 'Dashboard', module: dashboard, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'structure', label: 'Clients & accounts', module: structure, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'money', label: 'Money movements', module: money, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'operations', label: 'Operations', module: operations, roles: ['owner', 'admin'] },
  { key: 'mixes', label: 'Accumulators', module: mixes, roles: ['owner', 'admin'] },
  { key: 'withdrawals', label: 'Withdrawals', module: withdrawals, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'shareholders', label: 'Shareholders', module: shareholders, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'work', label: 'Tasks & questions', module: work, roles: ['owner', 'admin', 'shareholder'] },
  { key: 'admin', label: 'Platforms & settings', module: admin, roles: ['owner', 'admin', 'shareholder'] }
];

const app = { go: path => { location.hash = `#/${path}`; }, reload: () => route() };
const visible = () => VIEWS.filter(v => v.roles.includes(ctx.me.user.role));

async function route() {
  const [key = 'dashboard', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const view = visible().find(v => v.key === key) || visible()[0];
  mount('#nav', visible().map(v => html`<button type="button" data-view="${v.key}" class="${v.key === view.key ? 'active' : ''}" ${v.key === view.key ? raw('aria-current="page"') : ''}>${v.label}</button>`));
  $$('#nav [data-view]').forEach(b => b.addEventListener('click', () => { app.go(b.dataset.view); $('#sidebar').classList.remove('open'); }));
  const target = $('#view');
  mount(target, html`<p class="muted">Loading…</p>`);
  try { await view.module.render(target, app, rest.map(decodeURIComponent)); }
  catch (error) { if (error.status !== 401) { mount(target, html`<p class="notice">${error.message}</p>`); showError(error); } }
}

function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
  onSubmit($('#login-form'), async data => { await api('/api/auth/login', { method: 'POST', body: data, redirectOn401: false }); location.reload(); });
}

async function boot() {
  initLanguage();
  try { ctx.me = await api('/api/me', { redirectOn401: false }); } catch (error) { if (error.status === 401) return showLogin(); throw error; }
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  api('/api/health', { redirectOn401: false }).then(h => { $('#env-label').textContent = h.label; }).catch(() => {});
  mount('#me', html`<b>${ctx.me.user.displayName}</b><span>${ctx.me.user.role}</span><button type="button" id="lang-btn">EN / فا</button><button type="button" id="logout-btn">Sign out</button>`);
  $('#lang-btn').addEventListener('click', () => setLanguage(document.documentElement.lang === 'fa' ? 'en' : 'fa'));
  $('#logout-btn').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', redirectOn401: false }); } finally { location.hash = ''; location.reload(); } });
  $('#menu-btn').addEventListener('click', e => { const open = $('#sidebar').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); });
  window.addEventListener('hashchange', route);
  route();
}

// api() redirects to "/?signin=1" on 401; on this single page that just shows the login form again.
boot().catch(error => toast(error.message, 'error'));
