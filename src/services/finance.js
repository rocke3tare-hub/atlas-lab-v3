import { newId } from '../db/database.js';
import { AppError, invalid } from '../lib/errors.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { text, oneOf, isoDate, id as idField } from '../lib/validate.js';
import { distribute } from '../domain/profit.js';
import { audit, clientFilter, loadOwned, requireClient, requireRole, today } from './common.js';
import { accountMoney, post } from './money.js';
import { clientCapital } from './structure.js';
import { workbook, csv } from '../lib/xlsx.js';

// Profit and loss = money that crossed the books' boundary for trading reasons
// (payouts, stakes, income, costs, adjustments) plus every fee. Moving money
// between the client's own accounts, capital injections and shareholder
// payouts are not profit. Reversals count as the kind they reverse.
const PL_KINDS = "('income','cost','stake','payout','adjustment')";
const EFFECTIVE_KIND = "CASE WHEN m.kind = 'reversal' THEN (SELECT o.kind FROM movements o WHERE o.id = m.reverses_id) ELSE m.kind END";

export function profitAndLoss(db, { clientIds = null, from = null, to = null } = {}) {
  const params = { from: from || '0000-01-01', to: to || '9999-12-31' };
  let scope = '1 = 1';
  if (clientIds) { scope = clientIds.length ? `m.client_id IN (${clientIds.map((c, i) => { params[`c${i}`] = c; return `:c${i}`; }).join(', ')})` : '1 = 0'; }
  const rows = db.all(`SELECT currency, sum(gain) AS gain, sum(loss) AS loss, sum(fees) AS fees FROM (
      SELECT m.currency_in AS currency, CASE WHEN m.from_account_id IS NULL AND ${EFFECTIVE_KIND} IN ${PL_KINDS} THEN m.amount_in ELSE 0 END AS gain, 0 AS loss, 0 AS fees FROM movements m WHERE m.to_account_id IS NOT NULL AND ${scope} AND m.occurred_on BETWEEN :from AND :to
      UNION ALL
      SELECT m.currency_out, 0, CASE WHEN m.to_account_id IS NULL AND ${EFFECTIVE_KIND} IN ${PL_KINDS} THEN m.amount_out ELSE 0 END, m.fee FROM movements m WHERE m.from_account_id IS NOT NULL AND ${scope} AND m.occurred_on BETWEEN :from AND :to
    ) GROUP BY currency ORDER BY currency`, params);
  return rows.map(r => ({ currency: r.currency, gains: r.gain, losses: r.loss, fees: r.fees, net: r.gain - r.loss - r.fees }));
}

export function distribution(ctx, { from = '', to = '' } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const base = ctx.config.baseCurrency;
  const pl = profitAndLoss(ctx.db, { from: from ? isoDate(from, 'From') : null, to: to ? isoDate(to, 'To') : null });
  const profit = pl.find(r => r.currency === base)?.net ?? 0;
  const all = ctx.db.all('SELECT s.*, c.name AS client_name FROM shareholders s JOIN clients c ON c.id = s.client_id');
  const included = all.filter(s => s.currency === base);
  const result = distribute({
    profit,
    shareholders: included.map(s => ({
      id: s.id, clientId: s.client_id, status: s.status, profitShareBp: s.profit_share_bp, capital: clientCapital(ctx.db, s.client_id).capital,
      paid: ctx.db.get(`SELECT COALESCE(sum(amount), 0) AS v FROM shareholder_payments WHERE shareholder_id = :s AND status = 'completed'`, { s: s.id }).v
    }))
  });
  const names = Object.fromEntries(all.map(s => [s.id, s.client_name]));
  const visible = result.rows.filter(r => ctx.actor.clientIds === null || ctx.actor.clientIds.includes(r.clientId));
  return {
    currency: base, period: { from: from || null, to: to || null }, otherCurrencies: pl.filter(r => r.currency !== base),
    excluded: all.filter(s => s.currency !== base).map(s => s.client_name),
    profit: ctx.actor.role === 'owner' ? result.profit : undefined, totalCapital: ctx.actor.role === 'owner' ? result.totalCapital : undefined,
    roundingRemainder: ctx.actor.role === 'owner' ? result.roundingRemainder : undefined,
    rows: visible.map(r => ({ ...r, clientName: names[r.shareholderId] }))
  };
}

export function listPayments(ctx) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 's.client_id');
  return ctx.db.all(`SELECT p.*, c.name AS client_name, a.name AS from_account FROM shareholder_payments p JOIN shareholders s ON s.id = p.shareholder_id JOIN clients c ON c.id = s.client_id LEFT JOIN accounts a ON a.id = p.from_account_id WHERE ${scope.sql} ORDER BY p.created_at DESC`, scope.params);
}

export function createPayment(ctx, input) {
  requireRole(ctx, 'owner');
  const sh = ctx.db.get('SELECT * FROM shareholders WHERE id = :id', { id: idField(input.shareholderId, 'Shareholder') });
  if (!sh) throw new AppError('NOT_FOUND', 'Shareholder was not found.', 404);
  const amount = toMinor(input.amount, sh.currency, 'Amount', { allowZero: false });
  let fromAccount = null;
  if (input.fromAccountId) {
    fromAccount = loadOwned(ctx, 'accounts', idField(input.fromAccountId, 'Account'), 'Account');
    if (fromAccount.client_id !== sh.client_id || fromAccount.kind === 'platform' || fromAccount.currency !== sh.currency) throw invalid(`Pay from a ${sh.currency} wallet or bank of the same client.`);
  }
  const id = newId();
  ctx.db.run('INSERT INTO shareholder_payments(id, shareholder_id, amount, currency, from_account_id, note, created_by) VALUES (:id, :s, :a, :c, :f, :n, :u)', { id, s: sh.id, a: amount, c: sh.currency, f: fromAccount?.id ?? null, n: text(input.note, 'Note', { max: 300 }), u: ctx.actor.userId });
  audit(ctx, { action: 'payment.created', entityType: 'shareholder_payment', entityId: id, clientId: sh.client_id, after: { amount } });
  return id;
}

export function updatePayment(ctx, paymentId, input) {
  requireRole(ctx, 'owner');
  const p = ctx.db.get('SELECT p.*, s.client_id FROM shareholder_payments p JOIN shareholders s ON s.id = p.shareholder_id WHERE p.id = :id', { id: idField(paymentId, 'Payment') });
  if (!p) throw new AppError('NOT_FOUND', 'Payment was not found.', 404);
  if (p.status !== 'pending') throw new AppError('ALREADY_DECIDED', `This payment is already ${p.status}.`, 409);
  const status = oneOf(input.status, ['completed', 'failed', 'cancelled'], 'Status');
  let movementId = null;
  if (status === 'completed' && p.from_account_id) {
    movementId = post(ctx, { clientId: p.client_id, kind: 'shareholder_payment', from: p.from_account_id, amountOut: p.amount, occurredOn: isoDate(input.paidOn || today(), 'Paid on'), sourceType: 'shareholder_payment', sourceId: p.id, note: p.note });
  }
  ctx.db.run(`UPDATE shareholder_payments SET status = :s, movement_id = :m, completed_at = CASE WHEN :s = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id = :id`, { id: p.id, s: status, m: movementId });
  audit(ctx, { action: `payment.${status}`, entityType: 'shareholder_payment', entityId: p.id, clientId: p.client_id, reason: text(input.note, 'Note', { max: 300 }) });
}

/** Dashboard: per-client money by currency, plus open work. */
export function dashboard(ctx, { from = '', to = '' } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'a.client_id');
  const accounts = ctx.db.all(`SELECT a.* FROM accounts a WHERE ${scope.sql} AND a.status <> 'closed'`, scope.params);
  const totals = {};
  for (const a of accounts) {
    const m = accountMoney(ctx.db, a);
    const t = (totals[a.currency] ??= { currency: a.currency, wallet: 0, bank: 0, platform: 0, pendingWithdrawals: 0, reserved: 0, bonus: 0, freeBet: 0 });
    t[a.kind] += m.balance; t.pendingWithdrawals += m.pendingWithdrawals; t.reserved += m.reserved; t.bonus += m.bonus; t.freeBet += m.freeBet;
  }
  const ws = clientFilter(ctx, 'w.client_id');
  const pl = profitAndLoss(ctx.db, { clientIds: ctx.actor.clientIds, from: from ? isoDate(from, 'From') : null, to: to ? isoDate(to, 'To') : null });
  const openWithdrawals = ctx.db.get(`SELECT count(*) AS n, sum(CASE WHEN status IN ('delayed','verification','problem') THEN 1 ELSE 0 END) AS issues FROM withdrawals w WHERE ${ws.sql} AND status IN ('requested','delayed','verification','problem')`, ws.params);
  const ts = clientFilter(ctx, 't.client_id');
  const tasks = ctx.actor.role === 'shareholder' ? null : ctx.db.get(`SELECT count(*) AS n, sum(CASE WHEN due_on < date('now') THEN 1 ELSE 0 END) AS overdue FROM tasks t WHERE (t.client_id IS NULL OR ${ts.sql}) AND status = 'open'`, ts.params);
  return { balances: Object.values(totals), profitAndLoss: pl, openWithdrawals: openWithdrawals.n, withdrawalIssues: openWithdrawals.issues || 0, openTasks: tasks?.n ?? null, overdueTasks: tasks?.overdue ?? null };
}

// ---------- Tasks ----------

export function listTasks(ctx, { status = 'open' } = {}) {
  requireRole(ctx, 'owner', 'admin');
  const scope = clientFilter(ctx, 't.client_id');
  const p = { ...scope.params, status: oneOf(status, ['open', 'done', 'dismissed', 'all'], 'Status') };
  return ctx.db.all(`SELECT t.*, c.name AS client_name, u.display_name AS assignee FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE (t.client_id IS NULL OR ${scope.sql}) AND (:status = 'all' OR t.status = :status) ORDER BY t.status, COALESCE(t.due_on, '9999'), t.created_at LIMIT 500`, p);
}

export function createTask(ctx, input) {
  requireRole(ctx, 'owner', 'admin');
  const clientId = input.clientId ? idField(input.clientId, 'Client') : null;
  if (clientId) requireClient(ctx, clientId);
  let assignee = null;
  if (input.assigneeId) {
    if (ctx.actor.role !== 'owner') throw new AppError('PERMISSION_DENIED', 'Only the owner assigns tasks to others.', 403);
    assignee = idField(input.assigneeId, 'Assignee');
    if (!ctx.db.get(`SELECT 1 FROM users WHERE id = :id AND role IN ('owner','admin')`, { id: assignee })) throw invalid('Assign tasks to an owner or admin.');
  }
  const id = newId();
  ctx.db.run('INSERT INTO tasks(id, client_id, title, detail, assignee_id, priority, due_on, created_by) VALUES (:id, :c, :t, :d, :a, :p, :due, :u)', {
    id, c: clientId, t: text(input.title, 'Title', { required: true, max: 150 }), d: text(input.detail, 'Detail', { max: 1000 }), a: assignee || (ctx.actor.role === 'admin' ? ctx.actor.userId : null),
    p: oneOf(input.priority || 'normal', ['low', 'normal', 'high'], 'Priority'), due: input.dueOn ? isoDate(input.dueOn, 'Due date') : null, u: ctx.actor.userId
  });
  return id;
}

export function setTaskStatus(ctx, taskId, status) {
  requireRole(ctx, 'owner', 'admin');
  const t = ctx.db.get('SELECT * FROM tasks WHERE id = :id', { id: idField(taskId, 'Task') });
  if (!t || (t.client_id && !(ctx.actor.clientIds === null || ctx.actor.clientIds.includes(t.client_id)))) throw new AppError('NOT_FOUND', 'Task was not found.', 404);
  const s = oneOf(status, ['open', 'done', 'dismissed'], 'Status');
  ctx.db.run(`UPDATE tasks SET status = :s, closed_at = CASE WHEN :s = 'open' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id = :id`, { id: t.id, s });
}

// ---------- Questions (shareholder <-> team) ----------

export function listQuestions(ctx) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'q.client_id');
  return ctx.db.all(`SELECT q.*, c.name AS client_name, u.display_name AS author FROM questions q JOIN clients c ON c.id = q.client_id JOIN users u ON u.id = q.created_by WHERE ${scope.sql} ORDER BY q.status, q.created_at DESC`, scope.params)
    .map(q => ({ ...q, messages: ctx.db.all('SELECT m.body, m.created_at, u.display_name AS author, u.role FROM question_messages m JOIN users u ON u.id = m.created_by WHERE m.question_id = :q ORDER BY m.created_at', { q: q.id }) }));
}

export function askQuestion(ctx, input) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const clientId = idField(input.clientId, 'Client');
  requireClient(ctx, clientId);
  const id = newId();
  ctx.db.run('INSERT INTO questions(id, client_id, subject, created_by) VALUES (:id, :c, :s, :u)', { id, c: clientId, s: text(input.subject, 'Subject', { required: true, max: 150 }), u: ctx.actor.userId });
  ctx.db.run('INSERT INTO question_messages(id, question_id, body, created_by) VALUES (:id, :q, :b, :u)', { id: newId(), q: id, b: text(input.body, 'Message', { required: true, max: 3000 }), u: ctx.actor.userId });
  return id;
}

export function replyQuestion(ctx, questionId, input) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const q = loadOwned(ctx, 'questions', idField(questionId, 'Question'), 'Question');
  if (q.status === 'closed') throw invalid('This conversation is closed.');
  ctx.db.run('INSERT INTO question_messages(id, question_id, body, created_by) VALUES (:id, :q, :b, :u)', { id: newId(), q: q.id, b: text(input.body, 'Message', { required: true, max: 3000 }), u: ctx.actor.userId });
  if (input.close && ctx.actor.role !== 'shareholder') ctx.db.run(`UPDATE questions SET status = 'closed' WHERE id = :id`, { id: q.id });
}

// ---------- Exports ----------

export function exportWorkbook(ctx, { format = 'xlsx', from = '', to = '' } = {}) {
  requireRole(ctx, 'owner', 'admin', 'shareholder');
  const scope = clientFilter(ctx, 'm.client_id');
  const p = { ...scope.params, from: from ? isoDate(from, 'From') : '0000-01-01', to: to ? isoDate(to, 'To') : '9999-12-31' };
  const movements = ctx.db.all(`SELECT m.occurred_on, c.name AS client, m.kind, fa.name AS from_name, m.amount_out, m.fee, m.currency_out, ta.name AS to_name, m.amount_in, m.currency_in, m.note, m.reference
    FROM movements m JOIN clients c ON c.id = m.client_id LEFT JOIN accounts fa ON fa.id = m.from_account_id LEFT JOIN accounts ta ON ta.id = m.to_account_id
    WHERE ${scope.sql} AND m.occurred_on BETWEEN :from AND :to ORDER BY m.occurred_on, m.created_at`, p);
  const pl = profitAndLoss(ctx.db, { clientIds: ctx.actor.clientIds, from: from || null, to: to || null });
  const sheets = [
    { name: 'Movements', rows: [['Date', 'Client', 'Type', 'From', 'Amount out', 'Fee', 'Currency out', 'To', 'Amount in', 'Currency in', 'Note', 'Reference'], ...movements.map(r => [r.occurred_on, r.client, r.kind, r.from_name || '', r.currency_out ? fromMinor(r.amount_out, r.currency_out) : '', r.currency_out ? fromMinor(r.fee, r.currency_out) : '', r.currency_out || '', r.to_name || '', r.currency_in ? fromMinor(r.amount_in, r.currency_in) : '', r.currency_in || '', r.note || '', r.reference || ''])] },
    { name: 'Profit and loss', rows: [['Currency', 'Gains', 'Losses', 'Fees', 'Net'], ...pl.map(r => [r.currency, fromMinor(r.gains, r.currency), fromMinor(r.losses, r.currency), fromMinor(r.fees, r.currency), fromMinor(r.net, r.currency)])] }
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  if (oneOf(format, ['xlsx', 'csv'], 'Format') === 'csv') return { filename: `atlas-movements-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(csv(sheets[0].rows), 'utf8') };
  return { filename: `atlas-report-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: workbook(sheets) };
}

export function auditLog(ctx, { limit = 300 } = {}) {
  requireRole(ctx, 'owner');
  return ctx.db.all(`SELECT a.*, u.display_name AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT :l`, { l: Math.min(Math.max(Number(limit) || 300, 1), 1000) });
}
