// Temporary homepage enrollment form. Throwaway local DB only — never the live DB.
// Run: node test/enroll.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-enroll-'));
const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.ENROLL_TEST_PORT || '3097';
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'enroll-test-token-16+';
const ADMIN_EMAIL = 'admin@test.invalid';
const ADMIN_PW = 'EnrollAdmin12!';
const CLOSE = '2026-11-22T23:59:59+04:00';

const seedJs = `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
delete process.env.DATABASE_URL;
const db = require(${JSON.stringify(path.join(root, 'src/db.js'))});
const enroll = require(${JSON.stringify(path.join(root, 'src/enroll.js'))});
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(ADMIN_PW)}, 8);
db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'admin', 'Test Admin')").run(${JSON.stringify(ADMIN_EMAIL)}, hash);
const tid = db.prepare("INSERT INTO teachers (name, email) VALUES ('Pastor Test', 'bruce@test.invalid')").run().lastInsertRowid;
const thg = db.prepare("INSERT INTO courses (code, title, title_az) VALUES ('THG 101', 'Theology of Grace', 'Lütf İlahiyyatı')").run().lastInsertRowid;
const ecc = db.prepare("INSERT INTO courses (code, title, title_az) VALUES ('ECC 101', 'Body Life', 'Body Life')").run().lastInsertRowid;
db.prepare("INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?,'Payız 2026', 20)").run(thg, tid);
db.prepare("INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?,'Payız 2026', 1)").run(ecc, tid);

const assert = require('node:assert/strict');
assert.equal(enroll.normalizePhone('055 111 22 33'), '+994551112233');
assert.equal(enroll.normalizePhone('+99455 111 22 33'), '+994551112233');
assert.ok(enroll.phonesMatch('+994551112233', '0551112233'));
assert.equal(enroll.isOpen(new Date('2026-11-22T23:59:59+04:00')), true);
assert.equal(enroll.isOpen(new Date('2026-11-23T00:00:00+04:00')), false);

let r = enroll.submit({ name: 'Ayla Test', phone: '055 100 20 30', classes: ['THG 101', 'ECC 101'] });
assert.equal(r.ok, true); assert.equal(r.existing, false);
assert.deepEqual(r.enrolled.sort(), ['ECC 101', 'THG 101']);
const st = db.prepare('SELECT * FROM students WHERE id=?').get(r.student_id);
assert.equal(st.name, 'Ayla Test');
assert.equal(st.phone, '+994551002030');
assert.equal(st.whatsapp_phone, '+994551002030'); // phone used when WhatsApp left blank
assert.equal(st.user_id, null);
assert.equal(st.email, null);
assert.equal(st.status, 'active');
const req1 = enroll.get(r.id);
assert.equal(req1.source, 'homepage form');
assert.equal(req1.notified, false);
assert.equal(req1.review_flag, null);

// Dedupe by phone: same person, already in both, plus filling a WhatsApp
r = enroll.submit({ name: 'Ayla Test', phone: '+994551002030', whatsapp: '055 100 20 31', classes: 'THG 101' });
assert.equal(r.ok, true); assert.equal(r.existing, true);
assert.deepEqual(r.enrolled, []);
assert.equal(r.review_flag, 'existing student');
assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 1);
const st2 = db.prepare('SELECT * FROM students WHERE id=?').get(r.student_id);
assert.equal(st2.whatsapp_phone, '+994551002031');

// Capacity: ECC 101 has capacity 1 (Ayla took the seat). New student still created, not over-enrolled.
r = enroll.submit({ name: 'Murad Test', phone: '055 200 30 40', classes: ['ECC 101', 'THG 101'] });
assert.equal(r.ok, true); assert.equal(r.existing, false);
assert.deepEqual(r.enrolled, ['THG 101']);
assert.deepEqual(r.full, ['ECC 101']);
assert.equal(r.review_flag, 'class full — needs review');
const murad = db.prepare('SELECT * FROM students WHERE id=?').get(r.student_id);
assert.equal(murad.status, 'active'); // enrolled in THG
assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE c.code=\\'ECC 101\\'').get().n, 1);

// Class-full only (fill THG to 20 first, then a THG-only applicant)
const cap = 20;
const taken = db.prepare("SELECT COUNT(*) n FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE c.code='THG 101'").get().n;
for (let i = taken; i < cap; i++) {
  const s = enroll.submit({ name: 'Fill ' + i, phone: '055 300 ' + String(1000 + i), classes: ['THG 101'] });
  assert.equal(s.ok, true); assert.ok(s.enrolled.includes('THG 101'));
}
r = enroll.submit({ name: 'Nigar Wait', phone: '055 400 50 60', classes: 'THG 101' });
assert.equal(r.ok, true);
assert.deepEqual(r.enrolled, []);
assert.deepEqual(r.full, ['THG 101']);
assert.equal(r.review_flag, 'class full — needs review');
const nigar = db.prepare('SELECT * FROM students WHERE id=?').get(r.student_id);
assert.equal(nigar.status, 'applicant');
assert.equal(nigar.user_id, null);

// Validation
r = enroll.submit({ name: '', phone: '123', classes: [] });
assert.equal(r.ok, false); assert.ok(r.errors.length >= 2);

// Honeypot: pretend success, save nothing
const before = db.prepare('SELECT COUNT(*) n FROM enrollment_requests').get().n;
r = enroll.submit({ name: 'Bot', phone: '055 500 60 70', classes: 'THG 101', website: 'http://spam.example' });
assert.equal(r.ok, true); assert.equal(r.spam, true);
assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollment_requests').get().n, before);

// API helpers
const open = enroll.list({ unnotified: true });
assert.ok(open.length >= 3);
assert.equal(enroll.markNotified(open[0].id), true);
assert.equal(enroll.markNotified(open[0].id), false);
assert.equal(enroll.get(open[0].id).notified, true);

// Discard removes the applicant with no activity
const nid = db.prepare("SELECT id FROM enrollment_requests WHERE name='Nigar Wait'").get().id;
const sid = nigar.id;
const d = enroll.discard(nid);
assert.equal(d.ok, true);
assert.equal(db.prepare('SELECT 1 FROM enrollment_requests WHERE id=?').get(nid), undefined);
assert.equal(db.prepare('SELECT 1 FROM students WHERE id=?').get(sid), undefined);

// Login creation
const ayla = db.prepare("SELECT * FROM students WHERE name='Ayla Test'").get();
const login = enroll.createLogin(ayla.id, { email: 'ayla@test.invalid', password: 'StudentPass12' });
assert.equal(login.ok, true);
assert.ok(db.prepare('SELECT * FROM students WHERE id=?').get(ayla.id).user_id);
const again = enroll.createLogin(ayla.id, { email: 'other@test.invalid', password: 'StudentPass12' });
assert.equal(again.ok, false);

// Free seats in THG 101 so the HTTP tests can enroll a new student.
db.prepare("DELETE FROM enrollments WHERE student_id IN (SELECT id FROM students WHERE name LIKE 'Fill %')").run();
db.prepare("DELETE FROM students WHERE name LIKE 'Fill %'").run();
db.prepare("DELETE FROM enrollment_requests WHERE name LIKE 'Fill %'").run();

console.log('unit ok');
`;
fs.writeFileSync(path.join(dir, 'unit.cjs'), seedJs);
const unit = spawnSync(process.execPath, [path.join(dir, 'unit.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', ENROLLMENT_CLOSES_AT: CLOSE, NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (unit.status !== 0) { console.error(unit.stdout, unit.stderr); throw new Error('unit tests failed'); }
console.log('✓', unit.stdout.trim());

function start(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'enroll-test-secret-xxxx', DEMO_MODE: 'true', NODE_ENV: 'test', DATABASE_URL: '', HOMEWORK_API_TOKEN: TOKEN, ENROLLMENT_CLOSES_AT: CLOSE, EMAIL_SENDING_ENABLED: 'false', ...extraEnv },
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
  await srv.ready;
  let a = agent();
  let html = await a.text('/');
  assert.match(html, /id="qeydiyyat"/);
  assert.match(html, /Ad, soyad/);
  assert.match(html, /Theology of Grace/);
  assert.match(html, /Body Life/);
  assert.match(html, /Qeydiyyat/);
  assert.match(html, /name="website"/);
  const csrf = a.csrfFrom(html);
  assert.ok(csrf);
  step('homepage shows open bilingual form with CSRF and honeypot');

  let r = await a.req('/enroll', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: 'bad', name: 'X', phone: '055 111 11 11', classes: 'THG 101' }) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#qeydiyyat');
  step('bad CSRF redirects back to the form, not to login');

  r = await a.req('/enroll', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, name: 'Rashad Http', phone: '055 700 80 90', classes: 'THG 101' }) });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /tesekkur=1/);
  const thanks = await (await a.req(r.headers.get('location'))).text();
  assert.match(thanks, /Təşəkkür edirik/);
  step('valid submit shows the Azeri thank-you');

  r = await fetch(BASE + '/api/enrollments?unnotified=1');
  assert.equal(r.status, 401);
  r = await fetch(BASE + '/api/enrollments?unnotified=1', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert.equal(r.status, 200);
  const payload = await r.json();
  const item = payload.items.find(x => x.name === 'Rashad Http');
  assert.ok(item);
  assert.equal(item.source, 'homepage form');
  assert.equal(item.notified, false);
  assert.ok(item.student_id);
  assert.deepEqual(item.enrolled, ['THG 101']);
  step('token API lists the unnotified request');

  r = await fetch(BASE + '/api/enrollments/' + item.id + '/notified', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN } });
  assert.equal((await r.json()).ok, true);
  r = await fetch(BASE + '/api/enrollments?unnotified=1', { headers: { authorization: 'Bearer ' + TOKEN } });
  const after = await r.json();
  assert.equal(after.items.find(x => x.id === item.id), undefined);
  step('POST notified drops it from the unnotified list');

  // Login as admin, roster shows no-login pill, create login
  const admin = agent();
  const loginHtml = await admin.text('/login');
  r = await admin.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: admin.csrfFrom(loginHtml), email: ADMIN_EMAIL, password: ADMIN_PW }) });
  assert.equal(r.status, 302);
  const roster = await (await admin.req('/admin/students')).text();
  assert.match(roster, /Rashad Http/);
  assert.match(roster, /no login yet/);
  const enrollPage = await (await admin.req('/admin/enrollments')).text();
  assert.match(enrollPage, /Rashad Http/);
  step('admin roster and enrollments page show the new student');

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const rashad = db.prepare("SELECT * FROM students WHERE name='Rashad Http'").get();
  const prof = await (await admin.req('/admin/students/' + rashad.id)).text();
  assert.match(prof, /No login yet/);
  const pCsrf = admin.csrfFrom(prof);
  r = await admin.req('/admin/students/' + rashad.id + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: pCsrf, email: 'rashad@test.invalid', password: 'StudentPass12', confirm_password: 'StudentPass12' }) });
  assert.equal(r.status, 302);
  assert.ok(db.prepare('SELECT user_id FROM students WHERE id=?').get(rashad.id).user_id);
  step('admin can create a login for a student who has none');

  // Closed form: restart with a past close time
  srv.child.kill('SIGTERM');
  await new Promise(r => srv.child.once('exit', r));
  srv = start({ ENROLLMENT_CLOSES_AT: '2020-01-01T00:00:00+04:00' });
  await srv.ready;
  a = agent();
  html = await a.text('/');
  assert.match(html, /Qeydiyyat bağlanıb/);
  assert.doesNotMatch(html, /name="phone"/);
  const csrf2 = a.csrfFrom(html) || (await a.text('/login') && a.csrfFrom(await a.text('/login')));
  // Homepage still has a session csrf in the header sign-in? When closed, form is hidden so maybe no _csrf on the page except logout/signin.
  // GET / still runs csrfGuard, so the session has a token; we can get it from a hidden field if present, or from /login.
  const loginPage = await a.text('/login');
  const c2 = a.csrfFrom(loginPage);
  r = await a.req('/enroll', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: c2, name: 'Late Person', phone: '055 900 00 00', classes: 'THG 101' }) });
  assert.equal(r.status, 403);
  const closedBody = await r.text();
  assert.match(closedBody, /Qeydiyyat bağlanıb/);
  assert.equal(db.prepare("SELECT 1 FROM students WHERE name='Late Person'").get(), undefined);
  step('after close time the form is hidden and POST is rejected');
} finally {
  try { srv.child.kill('SIGTERM'); } catch {}
}
console.log('All enrollment tests passed.');
