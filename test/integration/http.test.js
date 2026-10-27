import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer, signedIn, client } from '../helpers.js';
import { buildConfig, assertSafeConfig } from '../../src/config.js';

const env = await startTestServer();
test.after(() => env.close());

test('static files: no traversal, no dotfiles, strict CSP on pages', async () => {
  for (const path of ['/..%2f..%2fpackage.json', '/.env', '/%2e%2e/src/config.js', '/app/../../package.json']) {
    const r = await fetch(env.base + path);
    assert.equal(r.status, 404, path);
  }
  const page = await fetch(env.base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('malformed URLs do not crash the server', async () => {
  const raw = await new Promise(resolve => {
    const socket = net.connect(new URL(env.base).port, '127.0.0.1', () => socket.write('GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = ''; socket.on('data', d => { data += d; }); socket.on('end', () => resolve(data));
  });
  assert.match(raw, /^HTTP\/1\.1 404/);
  assert.equal((await fetch(env.base + '/api/health')).status, 200);
});

test('CSRF: cross-origin and non-JSON mutations are refused', async () => {
  const owner = await signedIn(env.base, 'owner@atlas.local');
  const evil = await owner.raw('POST', '/api/clients', { name: 'x', code: 'X' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, 'CROSS_ORIGIN_DENIED');
  const form = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 415);
});

test('JSON bodies: size limit, invalid JSON, and multi-byte text across chunks', async () => {
  const big = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(300 * 1024) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const owner = await signedIn(env.base, 'owner@atlas.local');
  const name = 'مشتری '.repeat(30).slice(0, 80).trim();
  // ~110 KB of Persian padding forces the body across several TCP chunks.
  const created = await owner.post('/api/clients', { name, code: 'FA1', padding: 'ی'.repeat(55000) });
  assert.equal(created.status, 201);
  const list = await owner.get('/api/clients');
  assert.ok(list.body.data.some(c => c.name === name));
});

test('login lockout after repeated failures; generic error for unknown users', async () => {
  const c = client(env.base);
  const unknown = await c.post('/api/auth/login', { email: 'nobody@x.io', password: 'whatever-123' });
  assert.equal(unknown.body.error, 'INVALID_CREDENTIALS');
  for (let i = 0; i < 8; i += 1) await c.post('/api/auth/login', { email: 'admin@atlas.local', password: 'wrong-password' });
  const locked = await c.post('/api/auth/login', { email: 'admin@atlas.local', password: 'Test-password-123' });
  assert.equal(locked.status, 429);
});

test('production refuses unsafe configuration', () => {
  assert.throws(() => assertSafeConfig(buildConfig({ APP_ENV: 'production' })), /PASSWORD_PEPPER/);
  assert.doesNotThrow(() => assertSafeConfig(buildConfig({ APP_ENV: 'production', PASSWORD_PEPPER: 'x'.repeat(40), SECURE_COOKIES: 'true', PUBLIC_ORIGIN: 'https://shine.example' })));
});
