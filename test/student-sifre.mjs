// Student password change at /telebe/sifre. Uses a throwaway local DB only (never the live site).
// Run: node test/student-sifre.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-sifre-'));
const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.SIFRE_TEST_PORT || '3096';
const BASE = 'http://127.0.0.1:' + PORT;
const PW = 'SifreTest2026!';
const NEW_PW = 'SifreTestNew26!';

const seed = `process.env.DB_PATH=${JSON.stringify(dbPath)}; delete process.env.DATABASE_URL;
const db=require(${JSON.stringify(path.join(root, 'src/db.js'))});
const h=require('bcryptjs').hashSync(${JSON.stringify(PW)},6);
const u=(e,r,n)=>db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run(e,h,r,n).lastInsertRowid;
u('admin@test.invalid','admin','Test Admin');
const sid=u('s1@test.invalid','student','Aysel Test');
db.prepare('INSERT INTO students (user_id,name,email,status) VALUES (?,?,?,?)').run(sid,'Aysel Test','s1@test.invalid','active');
`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seed);
const sr = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (sr.status !== 0) { console.error(sr.stdout, sr.stderr); throw new Error('seed failed'); }

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'sifre-test-secret-xxxxxxxx', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: '', EMAIL_SENDING_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

const agent = () => {
  const jar = {};
  const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => {
    const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const text = async p => (await req(p)).text();
  const csrf = async p => (await text(p)).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, text, post, login: (e, password = PW, next = '') => post('/login', { email: e, password, next }) };
};
const step = m => console.log('✓', m);
const hashOf = (db) => db.prepare("SELECT password_hash FROM users WHERE email='s1@test.invalid'").get().password_hash;

try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} if (i > 80) throw new Error('server did not start: ' + out); await new Promise(r => setTimeout(r, 100)); }
  const db = new (require('better-sqlite3'))(dbPath);
  const before = hashOf(db);

  let r = await agent().req('/telebe/sifre');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login?next=' + encodeURIComponent('/telebe/sifre'));
  step('signed-out visitor is sent to login, then back to /telebe/sifre');

  const loginPage = await agent().text('/login');
  assert.match(loginPage, />Daxil ol · Sign in</);
  step('login button is bilingual');

  const admin = agent();
  await admin.login('admin@test.invalid');
  r = await admin.req('/telebe/sifre');
  assert.equal(r.status, 403);
  step('staff cannot open the student password page');

  const st = agent();
  await st.login('s1@test.invalid');
  const html = await st.text('/telebe/sifre');
  assert.match(html, /<h1>Şifrəni dəyiş<\/h1>/);
  assert.match(html, />İndiki şifrə</);
  assert.match(html, />Yeni şifrə \(ən azı 12 simvol\)</);
  assert.match(html, />Yeni şifrəni təkrar yazın</);
  assert.match(html, />Şifrəni dəyiş</);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /href="\/telebe\/sifre"[^>]*class="on">Şifrə</);
  const nav = await st.text('/telebe');
  assert.match(nav, /href="\/telebe\/sifre"[^>]*>Şifrə</);
  step('student sees the Şifrə page, exact Azeri labels, CSRF field, and nav link');

  r = await st.req('/telebe/sifre', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: 'bad-token', current_password: PW, new_password: NEW_PW, confirm_password: NEW_PW }) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/telebe/sifre');
  assert.equal(hashOf(db), before);
  step('POST without a valid CSRF token is rejected and the password is unchanged');

  r = await st.post('/telebe/sifre', { current_password: 'wrong-password-xx', new_password: NEW_PW, confirm_password: NEW_PW }, '/telebe/sifre');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/telebe/sifre');
  let bounced = await st.text('/telebe/sifre');
  assert.match(bounced, /İndiki şifrə düzgün deyil/);
  assert.equal(hashOf(db), before);
  step('wrong current password shows a warm Azeri error and does not change the hash');

  r = await st.post('/telebe/sifre', { current_password: PW, new_password: 'short', confirm_password: 'short' }, '/telebe/sifre');
  bounced = await st.text('/telebe/sifre');
  assert.match(bounced, /Yeni şifrə ən azı 12 simvol olmalıdır və hər iki yerdə eyni yazılmalıdır/);
  assert.equal(hashOf(db), before);

  r = await st.post('/telebe/sifre', { current_password: PW, new_password: NEW_PW, confirm_password: NEW_PW + 'x' }, '/telebe/sifre');
  bounced = await st.text('/telebe/sifre');
  assert.match(bounced, /Yeni şifrə ən azı 12 simvol olmalıdır və hər iki yerdə eyni yazılmalıdır/);
  assert.equal(hashOf(db), before);
  step('short or mismatched new password is rejected with an Azeri error');

  r = await st.post('/telebe/sifre', { current_password: PW, new_password: NEW_PW, confirm_password: NEW_PW }, '/telebe/sifre');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/telebe/sifre');
  const ok = await st.text('/telebe/sifre');
  assert.match(ok, /Şifrəniz dəyişdirildi/);
  assert.notEqual(hashOf(db), before);
  step('matching 12+ character password is saved and a success message is shown');

  const again = agent();
  r = await again.login('s1@test.invalid', PW);
  assert.equal(r.status, 401);
  const fresh = agent();
  r = await fresh.login('s1@test.invalid', NEW_PW);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/telebe');
  step('old password no longer signs in; the new one does');

  const audit = db.prepare("SELECT action, detail FROM audit_log WHERE action='password.change'").get();
  assert.ok(audit);
  assert.match(audit.detail, /telebe/);
  step('password change is recorded in the audit log');
} finally {
  child.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
