// CSRF failure messages and session cookie behaviour (memory store). Does not touch the live DB.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-sess-'));
const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.SESS_TEST_PORT || '3099';
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_EMAIL = 'admin@test.invalid';
const ADMIN_PW = 'TestAdmin2026!';
const SECRET = 'test-session-secret-csrf-xx';

const seedJs = `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
delete process.env.DATABASE_URL;
const db = require(${JSON.stringify(path.join(root, 'src/db.js'))});
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(ADMIN_PW)}, 8);
db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'admin', 'Test Admin')").run(${JSON.stringify(ADMIN_EMAIL)}, hash);
console.log('seeded');
`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seedJs);
const seeded = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (seeded.status !== 0) { console.error(seeded.stdout, seeded.stderr); throw new Error('seed failed'); }

function start() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: SECRET, DEMO_MODE: 'true', NODE_ENV: 'test', DATABASE_URL: '', EMAIL_SENDING_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { if ((await fetch(BASE + '/healthz')).ok) return resolve(out); } catch {}
      if (Date.now() - t0 > 8000) return reject(new Error('server did not start: ' + out));
      setTimeout(tick, 100);
    };
    tick();
  });
  return { child, ready, logs: () => out };
}

function agent() {
  const jar = {};
  const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, opt = {}) => {
    const r = await fetch(BASE + p, { redirect: 'manual', ...opt, headers: { cookie: ck(), ...(opt.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const text = async p => (await req(p)).text();
  const csrfFrom = html => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  return { jar, req, text, csrfFrom };
}

const step = m => console.log('✓', m);
let srv = start();
try {
  let logs = await srv.ready;
  assert.match(logs, /in-memory/i);
  step('memory store used when DATABASE_URL is unset');

  // Stale form, not signed in → login with expiry message, CSRF still required (wrong token is not accepted).
  let a = agent();
  const loginHtml = await a.text('/login');
  const good = a.csrfFrom(loginHtml);
  let r = await a.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: Object.entries(a.jar).map(([k, v]) => k + '=' + v).join('; ') }, body: new URLSearchParams({ _csrf: 'not-the-token', email: ADMIN_EMAIL, password: ADMIN_PW }) });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location') || '';
  assert.match(loc, /^\/login\?next=/);
  const bounced = await (await a.req(loc)).text();
  assert.match(bounced, /Your session expired\. Please sign in again\./);
  step('anonymous CSRF failure redirects to sign-in with an expiry message');

  // Fresh token still signs in.
  a = agent();
  r = await a.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: a.csrfFrom(await a.text('/login')), email: ADMIN_EMAIL, password: ADMIN_PW, next: '/admin/gradebook' }) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/gradebook');
  const gb = await a.req('/admin/gradebook');
  assert.equal(gb.status, 200);
  step('valid CSRF token still signs in');

  // Logged in, mismatched token → back to the referring page with a flash, still signed in.
  const gbHtml = await a.text('/admin/gradebook');
  const token = a.csrfFrom(gbHtml);
  r = await a.req('/admin/gradebook', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: BASE + '/admin/gradebook' }, body: new URLSearchParams({ _csrf: 'stale-token', title: 'should-not-save', max_points: '1', weight: '1' }) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/gradebook');
  const again = await a.text('/admin/gradebook');
  assert.match(again, /That form was out of date\. Please try again\./);
  assert.doesNotMatch(again, /should-not-save/);
  step('logged-in CSRF mismatch redirects back with a flash and does not apply the form');

  // Logout with the good token still works (harmless CSRF-protected POST).
  r = await a.req('/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token }) });
  assert.equal(r.status, 302);
  assert.equal((await a.req('/admin/gradebook')).status, 302);
  step('logout with a valid token succeeds');

  console.log('session-csrf: all checks passed');
} finally {
  try { srv.child.kill('SIGTERM'); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
