import crypto from 'node:crypto';
import { AppError } from '../lib/errors.js';
import { newId } from '../db/database.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password, pepper) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$16384$${salt}$${crypto.scryptSync(`${password}${pepper}`, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}

export function verifyPassword(password, stored, pepper) {
  const [scheme, n, salt, digest] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !/^[0-9a-f]+$/.test(digest || '')) return false;
  const expected = Buffer.from(digest, 'hex');
  const candidate = crypto.scryptSync(`${password}${pepper}`, salt, expected.length, { N: Number(n), r: 8, p: 1 });
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
    throw new AppError('WEAK_PASSWORD', `Passwords must be ${MIN_PASSWORD_LENGTH}–200 characters.`, 422);
  }
}

let dummyHash = null;
const WINDOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')";

export function login(db, config, { email, password, ip }) {
  const normalized = String(email || '').trim().toLowerCase();
  const ipHash = sha256(`${config.passwordPepper}:${ip || 'unknown'}`);
  const f = db.get(`SELECT (SELECT count(*) FROM login_attempts WHERE email = :e AND succeeded = 0 AND created_at > ${WINDOW}) AS by_email,
    (SELECT count(*) FROM login_attempts WHERE ip_hash = :i AND succeeded = 0 AND created_at > ${WINDOW}) AS by_ip`, { e: normalized, i: ipHash });
  if (f.by_email >= 8 || f.by_ip >= 30) throw new AppError('LOGIN_RATE_LIMITED', 'Too many failed sign-in attempts. Wait 15 minutes and try again.', 429);
  const user = normalized ? db.get('SELECT * FROM users WHERE email = :e', { e: normalized }) : null;
  dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'), config.passwordPepper);
  const valid = verifyPassword(String(password || ''), user?.password_hash ?? dummyHash, config.passwordPepper) && user?.status === 'active';
  db.run('INSERT INTO login_attempts(email, ip_hash, succeeded) VALUES (:e, :i, :ok)', { e: normalized, i: ipHash, ok: valid ? 1 : 0 });
  if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  db.run(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: user.id });
  return createSession(db, config, user.id);
}

export function createSession(db, config, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions(id, user_id, token_hash, expires_at) VALUES (:id, :u, :h, :x)', { id: newId(), u: userId, h: sha256(token), x: new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString() });
  return token;
}

export function revokeSession(db, token) {
  if (token) db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = :h AND revoked_at IS NULL`, { h: sha256(token) });
}
export function revokeAllSessions(db, userId) {
  db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = :u AND revoked_at IS NULL`, { u: userId });
}

/** Session token -> actor { userId, role, clientIds|null (null = all clients) }. */
export function actorFromToken(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const user = db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = :h AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`, { h: sha256(token) });
  if (!user || user.status !== 'active') return null;
  let clientIds = null;
  if (user.role === 'admin') clientIds = db.all('SELECT client_id FROM admin_clients WHERE user_id = :u', { u: user.id }).map(r => r.client_id);
  if (user.role === 'shareholder') clientIds = [user.client_id];
  return { userId: user.id, email: user.email, displayName: user.display_name, role: user.role, clientIds };
}
