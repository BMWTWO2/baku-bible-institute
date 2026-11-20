// Forgot-password flow against a throwaway DB and a file mailbox (no real email). Run: node test/password-reset.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-pw-')); const dbPath = path.join(dir, 'bbi.sqlite'); const box = path.join(dir, 'mailbox.jsonl');
const PORT = process.env.PW_TEST_PORT || '3097'; const BASE = 'http://127.0.0.1:' + PORT;
const USERS = [['admin@test.invalid', 'admin'], ['teacher@test.invalid', 'teacher'], ['student@test.invalid', 'student']];
fs.writeFileSync(path.join(dir, 'seed.cjs'), `process.env.DB_PATH=${JSON.stringify(dbPath)};delete process.env.DATABASE_URL;
const db=require(${JSON.stringify(path.join(root, 'src/db.js'))});const b=require('bcryptjs');const h=b.hashSync('OldPassword1',8);
for (const [e,r] of ${JSON.stringify(USERS)}) db.prepare("INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)").run(e,h,r,r);`);
const s = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (s.status !== 0) throw new Error(s.stderr);
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'test-session-secret-pwreset-xx', DEMO_MODE: 'true', NODE_ENV: 'test', DATABASE_URL: '', PWRESET_TEST_MAILBOX: box, EMAIL_SENDING_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
const agent = () => { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const post = async (p, body) => { const g = await (await req('/forgot-password')).text(); const csrf = (g.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    return req(p.split('?')[0], { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }) }); };
  return { req, post }; };
const mails = () => fs.existsSync(box) ? fs.readFileSync(box, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const step = m => console.log('✓', m);
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await wait(100); }
  let a = agent();
  const login = await (await a.req('/login')).text();
  assert.match(login, /href="\/forgot-password"[^>]*>Forgot password\? · Şifrəni unutmusunuz\?/); step('login page shows the link');
  assert.ok(login.indexOf('Sign in</button>') < login.indexOf('/forgot-password')); step('link sits below the Sign in button');
  // CSRF
  let r = await a.req('/forgot-password', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: 'bad', email: USERS[0][0] }) });
  assert.equal(r.status, 302); await wait(200); assert.equal(mails().length, 0); step('bad CSRF token rejected, nothing sent');
  // Neutral message: existing vs unknown identical
  const bodyOf = async email => { const x = await agent().post('/forgot-password', { email }); return [x.status, await x.text()]; };
  const strip = h => h.replace(/value="[0-9a-f]{48}"/g, '');
  const [s1, b1] = await bodyOf('nobody@example.invalid'); await wait(300); assert.equal(mails().length, 0);
  const [s2, b2] = await bodyOf(USERS[2][0]); await wait(500);
  assert.equal(s1, 200); assert.equal(s2, 200); assert.equal(strip(b1), strip(b2)); assert.match(b1, /If that email has an account, we sent a reset link/); assert.match(b1, /Əgər bu e-poçt/);
  step('same neutral page for unknown and known email; unknown sent nothing');
  assert.equal(mails().length, 1); let m = mails()[0]; assert.equal(m.to, USERS[2][0]); assert.match(m.text, /Pastor Bruce Wright/); assert.match(m.text, /1 saat/); assert.match(m.text, /1 hour/);
  const t1 = m.text.match(/reset-password\?token=([0-9a-f]{64})/)[1]; step('email went to the account address only, with a 64-hex token');
  // DB stores only the hash
  const q = spawnSync(process.execPath, ['-e', `process.env.DB_PATH=${JSON.stringify(dbPath)};const db=require('./src/db');console.log(JSON.stringify(db.prepare('select token_hash,expires_at from password_resets').all()))`], { cwd: root, encoding: 'utf8' });
  const rows = JSON.parse(q.stdout.trim().split('\n').pop()); assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(t1).digest('hex')); assert.notEqual(rows[0].token_hash, t1);
  const mins = (Date.parse(rows[0].expires_at) - Date.now()) / 6e4; assert.ok(mins > 58 && mins <= 60); step('only SHA-256 hash stored; expires in 60 min');
  // Second request invalidates first
  await bodyOf(USERS[2][0]); await wait(500); assert.equal(mails().length, 2); const t2 = mails()[1].text.match(/token=([0-9a-f]{64})/)[1];
  assert.equal((await a.req('/reset-password?token=' + t1)).status, 400); assert.equal((await a.req('/reset-password?token=' + t2)).status, 200); step('new request invalidates the older link');
  // Existing student session, then reset kills it
  const stu = agent(); const lg = await stu.post('/login', { email: USERS[2][0], password: 'OldPassword1', next: '' }); assert.equal(lg.status, 302);
  assert.equal((await stu.req('/telebe')).status, 200);
  // Validation
  const rp = agent();
  r = await rp.post('/reset-password?token=' + t2, { token: t2, password: 'short', confirm_password: 'short' }); assert.equal(r.status, 400); assert.match(await r.text(), /at least 8/);
  r = await rp.post('/reset-password?token=' + t2, { token: t2, password: 'NewPassword9', confirm_password: 'Different99' }); assert.equal(r.status, 400); assert.match(await r.text(), /do not match/); step('short / mismatched passwords rejected, token still valid');
  r = await rp.post('/reset-password?token=' + t2, { token: t2, password: 'NewPassword9', confirm_password: 'NewPassword9' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  assert.match(await (await rp.req('/login')).text(), /Your password was changed/); step('reset succeeds, redirects to /login with success flash');
  r = await rp.post('/reset-password?token=' + t2, { token: t2, password: 'AnotherPass1', confirm_password: 'AnotherPass1' }); assert.equal(r.status, 400); step('token is single use');
  assert.equal((await stu.req('/telebe')).status, 302); step('older signed-in session for that user was signed out');
  assert.equal((await agent().post('/login', { email: USERS[2][0], password: 'OldPassword1', next: '' })).status, 401);
  assert.equal((await agent().post('/login', { email: USERS[2][0], password: 'NewPassword9', next: '' })).status, 302); step('old password fails, new password works');
  assert.equal((await agent().post('/login', { email: USERS[0][0], password: 'OldPassword1', next: '' })).status, 302); step('other users untouched');
  // Admin + teacher also work
  for (const [e] of [USERS[0], USERS[1]]) { const before = mails().length; await bodyOf(e); await wait(400); assert.equal(mails().length, before + 1); assert.equal(mails().at(-1).to, e); } step('works for admin and teacher accounts too');
  // Rate limit: 3 per email per hour (student already has 2 issued)
  const before = mails().length; for (let i = 0; i < 4; i++) { await bodyOf(USERS[2][0]); await wait(250); }
  assert.equal(mails().length - before, 1); step('rate limit: max 3 emails per address per hour (neutral page still shown)');
  assert.equal((await agent().req('/reset-password?token=zzz')).status, 400);
  assert.ok(!/token=[0-9a-f]{64}/.test(out) && !/OldPassword|NewPassword/.test(out)); step('server log contains no tokens or passwords');
  console.log('ALL PASSED');
} finally { child.kill(); }
