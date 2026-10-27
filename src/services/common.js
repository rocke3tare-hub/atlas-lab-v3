import { AppError, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../db/database.js';

// Roles: owner (everything), admin (operates assigned clients), shareholder
// (reads its own client). The server enforces this on every call.
export const isOwner = ctx => ctx.actor?.role === 'owner';
export const isShareholder = ctx => ctx.actor?.role === 'shareholder';

export function requireRole(ctx, ...roles) {
  if (!ctx.actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Sign in is required.', 401);
  if (!roles.includes(ctx.actor.role)) throw forbidden();
}

/** Owners and admins can change data; shareholders are read-only. */
export const requireOperator = ctx => requireRole(ctx, 'owner', 'admin');

export function canSeeClient(ctx, clientId) {
  return ctx.actor.clientIds === null || ctx.actor.clientIds.includes(clientId);
}

export function requireClient(ctx, clientId) {
  if (!clientId || !canSeeClient(ctx, clientId)) throw new AppError('CLIENT_ACCESS_DENIED', 'This client is outside your access.', 403);
}

/** SQL fragment restricting a client_id column to the actor's scope. */
export function clientFilter(ctx, column = 'client_id') {
  if (ctx.actor.clientIds === null) return { sql: '1 = 1', params: {} };
  if (!ctx.actor.clientIds.length) return { sql: '1 = 0', params: {} };
  const params = {};
  const names = ctx.actor.clientIds.map((id, i) => { params[`scope_c${i}`] = id; return `:scope_c${i}`; });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

/** Load a row by id from a client-owned table and check scope. */
export function loadOwned(ctx, table, id, label) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
  const row = ctx.db.get(`SELECT * FROM ${table} WHERE id = :id`, { id });
  if (!row) throw notFound(label);
  if (!canSeeClient(ctx, row.client_id)) throw notFound(label);
  return row;
}

export function audit(ctx, { action, entityType, entityId = null, clientId = null, before = null, after = null, reason = null }) {
  ctx.db.run(`INSERT INTO audit_events(client_id, user_id, role, action, entity_type, entity_id, before_values, after_values, reason, request_id)
    VALUES (:c, :u, :r, :a, :t, :e, :b, :af, :re, :q)`, {
    c: clientId, u: ctx.actor?.userId ?? null, r: ctx.actor?.role ?? null, a: action, t: entityType, e: entityId,
    b: before == null ? null : JSON.stringify(before), af: after == null ? null : JSON.stringify(after), re: reason, q: ctx.requestId ?? null
  });
}

/** Open a follow-up task once per source (a unique index prevents duplicates). */
export function openTask(ctx, { clientId, title, detail = null, sourceType, sourceId, priority = 'normal', dueOn = null }) {
  ctx.db.run(`INSERT OR IGNORE INTO tasks(id, client_id, title, detail, source_type, source_id, priority, due_on, created_by)
    VALUES (:id, :c, :t, :d, :st, :si, :p, :due, :u)`, { id: newId(), c: clientId, t: title, d: detail, st: sourceType, si: sourceId, p: priority, due: dueOn, u: ctx.actor?.userId ?? null });
}

export function closeTasks(ctx, sourceType, sourceId) {
  ctx.db.run(`UPDATE tasks SET status = 'done', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_type = :st AND source_id = :si AND status = 'open'`, { st: sourceType, si: sourceId });
}

export function getSetting(db, key, fallback) {
  const row = db.get('SELECT value FROM settings WHERE key = :k', { k: key });
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function setSetting(db, key, value) {
  db.run('INSERT INTO settings(key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { k: key, v: JSON.stringify(value) });
}

export const today = () => new Date().toISOString().slice(0, 10);
