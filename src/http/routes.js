import { AppError } from '../lib/errors.js';
import { id as idField } from '../lib/validate.js';
import { CURRENCIES } from '../lib/money.js';
import { OUTCOME_TYPES, MARKET_TYPES, SCENARIO_LABELS } from '../domain/calculator.js';
import * as auth from '../services/auth.js';
import * as money from '../services/money.js';
import * as structure from '../services/structure.js';
import * as operations from '../services/operations.js';
import * as mixes from '../services/mixes.js';
import * as finance from '../services/finance.js';

const routes = [];
const route = (method, pattern, handler, { auth: needsAuth = true, tx = method !== 'GET' } = {}) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, regex, keys, handler, needsAuth, tx });
};
const uid = (params, key = 'id') => idField(params[key], key);
const q = (query, ...keys) => Object.fromEntries(keys.map(k => [k, query.get(k) || '']));

route('GET', '/api/health', ({ config }) => ({ data: { status: 'ok', label: config.label } }), { auth: false });
route('POST', '/api/auth/login', ({ db, config, body, ip }) => ({ cookie: auth.login(db, config, { email: body.email, password: body.password, ip }), data: { signedIn: true } }), { auth: false, tx: false });
route('POST', '/api/auth/logout', ({ db, token }) => { auth.revokeSession(db, token); return { cookie: '', data: { signedOut: true } }; }, { auth: false });
route('GET', '/api/me', ({ ctx, config }) => ({ data: { user: ctx.actor, baseCurrency: config.baseCurrency, currencies: Object.keys(CURRENCIES), currencyDecimals: Object.fromEntries(Object.entries(CURRENCIES).map(([k, v]) => [k, v.decimals])), outcomes: Object.fromEntries(Object.entries(OUTCOME_TYPES).map(([k, v]) => [k, { label: v.label, threeWayOnly: Boolean(v.threeWayOnly) }])), markets: Object.fromEntries(Object.entries(MARKET_TYPES).map(([k, v]) => [k, v])), scenarios: SCENARIO_LABELS } }));
route('POST', '/api/auth/password', ({ ctx, config, body }) => { structure.changePassword(ctx, config, body, auth.verifyPassword); return { cookie: '', data: { changed: true } }; });

// Structure
route('GET', '/api/clients', ({ ctx }) => ({ data: structure.listClients(ctx) }));
route('POST', '/api/clients', ({ ctx, body }) => ({ status: 201, data: { id: structure.saveClient(ctx, body) } }));
route('PATCH', '/api/clients/:id', ({ ctx, params, body }) => ({ data: { id: structure.saveClient(ctx, body, uid(params)) } }));
route('PUT', '/api/clients/:id/shareholder', ({ ctx, params, body }) => { structure.saveShareholder(ctx, uid(params), body); return { data: { saved: true } }; });
route('GET', '/api/structure', ({ ctx, query }) => ({ data: structure.structure(ctx, q(query, 'clientId')) }));
route('POST', '/api/holders', ({ ctx, body }) => ({ status: 201, data: { id: structure.saveHolder(ctx, body) } }));
route('PATCH', '/api/holders/:id', ({ ctx, params, body }) => ({ data: { id: structure.saveHolder(ctx, body, uid(params)) } }));
route('POST', '/api/accounts', ({ ctx, body }) => ({ status: 201, data: { id: structure.saveAccount(ctx, body) } }));
route('PATCH', '/api/accounts/:id', ({ ctx, params, body }) => ({ data: { id: structure.saveAccount(ctx, body, uid(params)) } }));
route('GET', '/api/platforms', ({ ctx }) => ({ data: structure.listPlatforms(ctx) }));
route('POST', '/api/platforms', ({ ctx, body }) => ({ status: 201, data: { id: structure.savePlatform(ctx, body) } }));
route('PATCH', '/api/platforms/:id', ({ ctx, params, body }) => ({ data: { id: structure.savePlatform(ctx, body, uid(params)) } }));
route('POST', '/api/platforms/:id/rules', ({ ctx, params, body }) => ({ status: 201, data: { id: structure.addRuleVersion(ctx, uid(params), body) } }));
route('GET', '/api/contributions', ({ ctx }) => ({ data: structure.listContributions(ctx) }));
route('POST', '/api/contributions', ({ ctx, body }) => ({ status: 201, data: { id: structure.requestContribution(ctx, body) } }));
route('POST', '/api/contributions/:id/decision', ({ ctx, params, body }) => { structure.decideContribution(ctx, uid(params), body); return { data: { decided: true } }; });

// Money
route('GET', '/api/movements', ({ ctx, query }) => ({ data: money.listMovements(ctx, q(query, 'clientId', 'accountId', 'from', 'to', 'limit')) }));
route('POST', '/api/movements', ({ ctx, body }) => ({ status: 201, data: money.recordMovement(ctx, body) }));
route('POST', '/api/movements/:id/reverse', ({ ctx, params, body }) => ({ status: 201, data: money.reverseMovement(ctx, uid(params), body) }));
route('POST', '/api/fundings', ({ ctx, body }) => ({ status: 201, data: money.fundPlatform(ctx, body) }));
route('POST', '/api/bonuses', ({ ctx, body }) => ({ status: 201, data: money.creditBonus(ctx, body) }));
route('GET', '/api/withdrawals', ({ ctx, query }) => ({ data: money.listWithdrawals(ctx, q(query, 'status')) }));
route('POST', '/api/withdrawals', ({ ctx, body }) => ({ status: 201, data: money.requestWithdrawal(ctx, body) }));
route('PATCH', '/api/withdrawals/:id', ({ ctx, params, body }) => ({ data: money.updateWithdrawal(ctx, uid(params), body) }));

// Operations
route('GET', '/api/operations', ({ ctx }) => ({ data: operations.listOperations(ctx) }));
route('POST', '/api/operations', ({ ctx, body }) => ({ status: 201, data: operations.createOperation(ctx, body) }));
route('GET', '/api/operations/:id', ({ ctx, params }) => ({ data: operations.getOperation(ctx, uid(params)) }));
route('PATCH', '/api/operations/:id', ({ ctx, params, body }) => ({ data: operations.setOperationStatus(ctx, uid(params), body.status) }));
route('POST', '/api/operations/:id/events', ({ ctx, params, body }) => ({ status: 201, data: operations.addEvent(ctx, uid(params), body) }));
route('POST', '/api/events/:id/plan', ({ ctx, params, body }) => ({ data: operations.planEvent(ctx, uid(params), body) }));
route('POST', '/api/events/:id/eligibility', ({ ctx, params, body }) => ({ data: operations.checkEligibility(ctx, uid(params), body) }), { tx: false });
route('POST', '/api/events/:id/bets', ({ ctx, params, body }) => ({ status: 201, data: operations.reserveBet(ctx, uid(params), body) }));
route('POST', '/api/events/:id/settle', ({ ctx, params, body }) => ({ data: operations.settleEvent(ctx, uid(params), body) }));
route('POST', '/api/bets/:id/place', ({ ctx, params }) => ({ data: operations.placeBet(ctx, uid(params)) }));
route('POST', '/api/bets/:id/cancel', ({ ctx, params, body }) => ({ data: operations.cancelBet(ctx, uid(params), body) }));

// Mixes
route('GET', '/api/mixes', ({ ctx }) => ({ data: mixes.listMixes(ctx) }));
route('POST', '/api/mixes', ({ ctx, body }) => ({ status: 201, data: mixes.createMix(ctx, body) }));
route('GET', '/api/mixes/:id', ({ ctx, params }) => ({ data: mixes.getMix(ctx, uid(params)) }));
route('POST', '/api/mixes/:id/legs', ({ ctx, params, body }) => ({ data: mixes.addLeg(ctx, uid(params), body) }));
route('DELETE', '/api/mixes/:id/legs/:leg', ({ ctx, params }) => ({ data: mixes.removeLeg(ctx, uid(params), params.leg) }));
route('POST', '/api/mixes/:id/lock', ({ ctx, params, body }) => ({ data: mixes.lockMix(ctx, uid(params), body) }));
route('POST', '/api/mixes/:id/hedges', ({ ctx, params, body }) => ({ data: mixes.addHedge(ctx, uid(params), body) }));
route('GET', '/api/mixes/:id/suggestion', ({ ctx, params, query }) => ({ data: mixes.suggestHedge(ctx, uid(params), query.get('odds')) }));
route('POST', '/api/mixes/:id/settle', ({ ctx, params, body }) => ({ data: mixes.settleLeg(ctx, uid(params), body) }));

// Finance, tasks, questions, users, reports
route('GET', '/api/dashboard', ({ ctx, query }) => ({ data: finance.dashboard(ctx, q(query, 'from', 'to')) }));
route('GET', '/api/distribution', ({ ctx, query }) => ({ data: finance.distribution(ctx, q(query, 'from', 'to')) }));
route('GET', '/api/payments', ({ ctx }) => ({ data: finance.listPayments(ctx) }));
route('POST', '/api/payments', ({ ctx, body }) => ({ status: 201, data: { id: finance.createPayment(ctx, body) } }));
route('PATCH', '/api/payments/:id', ({ ctx, params, body }) => { finance.updatePayment(ctx, uid(params), body); return { data: { updated: true } }; });
route('GET', '/api/tasks', ({ ctx, query }) => ({ data: finance.listTasks(ctx, { status: query.get('status') || 'open' }) }));
route('POST', '/api/tasks', ({ ctx, body }) => ({ status: 201, data: { id: finance.createTask(ctx, body) } }));
route('PATCH', '/api/tasks/:id', ({ ctx, params, body }) => { finance.setTaskStatus(ctx, uid(params), body.status); return { data: { updated: true } }; });
route('GET', '/api/questions', ({ ctx }) => ({ data: finance.listQuestions(ctx) }));
route('POST', '/api/questions', ({ ctx, body }) => ({ status: 201, data: { id: finance.askQuestion(ctx, body) } }));
route('POST', '/api/questions/:id/messages', ({ ctx, params, body }) => { finance.replyQuestion(ctx, uid(params), body); return { status: 201, data: { sent: true } }; });
route('GET', '/api/users', ({ ctx }) => ({ data: structure.listUsers(ctx) }));
route('POST', '/api/users', ({ ctx, config, body }) => ({ status: 201, data: structure.createUser(ctx, config, body) }));
route('PUT', '/api/users/:id/clients', ({ ctx, params, body }) => { structure.setAdminClients(ctx, uid(params), body.clientIds || []); return { data: { saved: true } }; });
route('PATCH', '/api/users/:id', ({ ctx, params, body }) => { structure.setUserStatus(ctx, uid(params), body.status); return { data: { saved: true } }; });
route('GET', '/api/audit', ({ ctx, query }) => ({ data: finance.auditLog(ctx, { limit: query.get('limit') }) }));
route('GET', '/api/export', ({ ctx, query }) => ({ file: finance.exportWorkbook(ctx, q(query, 'format', 'from', 'to')) }));

export function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    let params;
    try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { throw new AppError('BAD_REQUEST', 'Malformed URL.', 400); }
    return { route: r, params };
  }
  return { route: null, pathMatched };
}
