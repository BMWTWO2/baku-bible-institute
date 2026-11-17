// QR self-enrollment, approve/reject, pending attendance, welcome-password API.
// Throwaway local DB only — never the live DB. Run: node test/qr-self-enroll.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-qr-enroll-'));
const dbPath = path.join(dir, 'bbi.sqlite');
process.env.DB_PATH = dbPath;
delete process.env.DATABASE_URL;
const PORT = process.env.QR_ENROLL_TEST_PORT || '3099';
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'enroll-test-token-16+';
const ADMIN_EMAIL = 'admin@test.invalid';
const ADMIN_PW = 'EnrollAdmin12!';
const STUDENT_EMAIL = 'existing@test.invalid';
const STUDENT_PW = 'ExistingPass12';

const seedJs = `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
delete process.env.DATABASE_URL;
const db = require(${JSON.stringify(path.join(root, 'src/db.js'))});
const attqr = require(${JSON.stringify(path.join(root, 'src/attqr.js'))});
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(ADMIN_PW)}, 8);
db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'admin', 'Test Admin')").run(${JSON.stringify(ADMIN_EMAIL)}, hash);
const su = db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'student', 'Existing Student')").run(${JSON.stringify(STUDENT_EMAIL)}, bcrypt.hashSync(${JSON.stringify(STUDENT_PW)}, 8)).lastInsertRowid;
const tid = db.prepare("INSERT INTO teachers (name, email) VALUES ('Pastor Test', 'bruce@test.invalid')").run().lastInsertRowid;
const thg = db.prepare("INSERT INTO courses (code, title, title_az) VALUES ('THG 101', 'Theology of Grace', 'Lütf İlahiyyatı')").run().lastInsertRowid;
db.prepare("INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?,'Payız 2026', 20)").run(thg, tid);
const st = db.prepare("INSERT INTO students (user_id, name, email, status) VALUES (?,?,?,'active')").run(su, 'Existing Student', ${JSON.stringify(STUDENT_EMAIL)}).lastInsertRowid;
db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?, 1)').run(st);
attqr.ensureWindow();
`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seedJs);
const sr = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (sr.status !== 0) { console.error(sr.stdout, sr.stderr); throw new Error('seed failed'); }

const start = (extra = {}) => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'qr-enroll-test-secret-xx', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: '', HOMEWORK_API_TOKEN: TOKEN, ENROLLMENT_CLOSES_AT: '2020-01-01T00:00:00+04:00', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const ready = (async () => { for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} if (i > 80) throw new Error('server did not start: ' + out); await new Promise(r => setTimeout(r, 100)); } })();
  return { child, ready, out: () => out };
};

const agent = () => { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    r.cookies = r.headers.getSetCookie?.() || []; for (const c of r.cookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const text = async p => (await req(p)).text();
  const csrfFrom = html => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrfFrom(await text(from)), ...data }) });
  return { req, text, csrfFrom, post, login: (e, pw, next = '') => post('/login', { email: e, password: pw, next }, '/login' + (next ? '?next=' + encodeURIComponent(next) : '')) };
};

const api = (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: 'Bearer ' + TOKEN, ...(o.headers || {}) } });
const step = m => console.log('✓', m);
const Database = require('better-sqlite3');

let srv;
try {
  srv = start();
  await srv.ready;

  const db = new Database(dbPath);
  const code = db.prepare("SELECT ac.*, c.code, c.title, c.title_az FROM attendance_codes ac JOIN sections sec ON sec.id=ac.section_id JOIN courses c ON c.id=sec.course_id WHERE ac.week_no = (SELECT MIN(week_no) FROM attendance_codes)").get();
  assert.ok(code && code.token);
  const tok = code.token;
  const loginPath = '/login?next=' + encodeURIComponent('/qeyd/' + tok);
  const formPath = '/qeyd/' + tok + '/qeydiyyat';

  // Login page (QR next) shows the self-enroll button, not "go to your teacher"
  let a = agent();
  let html = await a.text(loginPath);
  assert.match(html, /Davamiyyət üçün bir dəfə daxil olun/);
  assert.match(html, /Yeniyəm — qeydiyyatdan keç/);
  assert.doesNotMatch(html, /Müəlliminizə yaxınlaşın/);
  assert.match(html, new RegExp('/qeyd/' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/qeydiyyat'));
  step('QR login page offers self-enroll, keeps the sign-in-once line');

  // Form is open even though the homepage enrollment window is closed
  const home = await a.text('/');
  assert.match(home, /Qeydiyyat bağlanıb/);
  const form = await a.text(formPath);
  assert.equal((await a.req(formPath)).status, 200);
  assert.match(form, /Ad, soyad/);
  assert.match(form, /WhatsApp nömrəsi/);
  assert.match(form, /Qeyd \(istəyə bağlı\)|Qeyd <span/);
  assert.match(form, /Qeydiyyatdan keç/);
  assert.match(form, /name="website"/);
  step('self-enroll form is available while the homepage form is closed');

  // Validation
  let r = await a.post(formPath, { name: '', email: 'bad', whatsapp: 'nope' }, formPath);
  assert.equal(r.status, 400);
  const bad = await r.text();
  assert.match(bad, /adınızı və soyadınızı/i);
  step('invalid form shows short Azeri errors');

  // Honeypot is accepted as thanks, stores nothing
  r = await a.post(formPath, { name: 'Spam Bot', email: 'spam@test.invalid', whatsapp: '055 111 22 33', website: 'http://spam.example' }, formPath);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /tesekkur=1/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM students WHERE name='Spam Bot'").get().n, 0);
  step('honeypot is swallowed');

  // Happy path
  const guest = agent();
  r = await guest.post(formPath, { name: 'Ayla Qr Test', email: 'ayla.qr@test.invalid', whatsapp: '055 111 22 33', note: 'first class' }, formPath);
  assert.equal(r.status, 302);
  const thanks = await (await guest.req(r.headers.get('location'))).text();
  assert.match(thanks, /Təşəkkür edirik!/);
  assert.match(thanks, /Qeydiyyatınız qəbul olundu/);
  assert.match(thanks, /Bu dərsdə iştirakınız qeyd olundu/);
  assert.match(thanks, /Pastor Bruce tezliklə sizə giriş məlumatlarınızı göndərəcək/);
  const ayla = db.prepare("SELECT * FROM students WHERE email='ayla.qr@test.invalid'").get();
  assert.ok(ayla); assert.equal(ayla.user_id, null);
  const att = db.prepare("SELECT * FROM attendance WHERE student_id=?").get(ayla.id);
  assert.equal(att.status, 'present'); assert.equal(att.source, 'qr-pending');
  const grade = db.prepare("SELECT g.points FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE g.student_id=? AND gi.kind='attendance'").get(ayla.id);
  assert.equal(grade, undefined, 'pending attendance must not create a grade');
  step('submit stores pending attendance and shows the Azeri confirmation');

  // Dedupe by email + token
  r = await guest.post(formPath, { name: 'Ayla Qr Test', email: 'ayla.qr@test.invalid', whatsapp: '055 111 22 33' }, formPath);
  assert.equal(r.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM enrollment_requests WHERE lower(email)='ayla.qr@test.invalid'").get().n, 1);
  step('duplicate email+token is idempotent');

  // Existing login is told to sign in
  r = await guest.post(formPath, { name: 'Existing Student', email: STUDENT_EMAIL, whatsapp: '055 222 33 44' }, formPath);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /Bu email ilə hesab artıq var/);
  step('existing login is directed to sign in');

  // Unnotified API includes QR class metadata
  r = await api('/api/enrollments?unnotified=1');
  assert.equal(r.status, 200);
  const payload = await r.json();
  const item = payload.items.find(x => x.name === 'Ayla Qr Test');
  assert.ok(item);
  assert.equal(item.via, 'qr');
  assert.match(item.source, /^QR self-enroll · THG 101 · week /);
  assert.equal(item.course_code, 'THG 101');
  assert.equal(item.review_status, 'pending');
  assert.equal(item.week_no, code.week_no);
  assert.ok(item.email);
  assert.equal(item.note, 'first class');
  step('unnotified API lists the QR request with class and via=qr');

  // Auto-absence leaves the pending self-enrollee alone
  const attqr = require(path.join(root, 'src/attqr.js'));
  // Close the week as if it were over: mark one real scan first so the class counts as held, then close.
  const existing = db.prepare("SELECT id FROM students WHERE email=?").get(STUDENT_EMAIL);
  db.prepare("INSERT OR IGNORE INTO attendance (session_id, student_id, status, note, source) VALUES (?,?, 'present', 'QR check-in', 'qr')").run(item.session_id, existing.id);
  db.prepare("UPDATE attendance_codes SET valid_until=date('now','-1 day'), valid_from=date('now','-8 day') WHERE token=?").run(tok);
  const closed = attqr.closePastWeeks();
  const still = db.prepare('SELECT * FROM attendance WHERE student_id=? AND session_id=?').get(ayla.id, item.session_id);
  assert.equal(still.source, 'qr-pending');
  assert.equal(still.status, 'present');
  step('auto-absence leaves pending self-enrollees alone (closed=' + closed.closed + ')');

  // Re-open the week so approve can still treat it as this session
  db.prepare("UPDATE attendance_codes SET valid_from=date('now','-1 day'), valid_until=date('now','+5 day'), closed_at=NULL WHERE token=?").run(tok);

  // Admin approve creates a login; password is in the welcome API only, never on the page
  const admin = agent();
  await admin.login(ADMIN_EMAIL, ADMIN_PW);
  const listHtml = await admin.text('/admin/enrollments');
  assert.match(listHtml, /Ayla Qr Test/);
  assert.match(listHtml, /Approve/);
  assert.doesNotMatch(listHtml, /temp_password|Temporary password/i);
  r = await admin.post('/admin/enrollments/' + item.id + '/approve', {}, '/admin/enrollments');
  assert.equal(r.status, 302);
  const flashPage = await admin.text('/admin/enrollments');
  assert.match(flashPage, /Approved/);
  const ayla2 = db.prepare('SELECT * FROM students WHERE id=?').get(ayla.id);
  assert.ok(ayla2.user_id);
  const att2 = db.prepare('SELECT * FROM attendance WHERE student_id=? AND session_id=?').get(ayla.id, item.session_id);
  assert.equal(att2.source, 'qr');
  const pts = db.prepare("SELECT g.points FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE g.student_id=? AND gi.kind='attendance'").get(ayla.id);
  assert.ok(pts && pts.points > 0);
  step('approve creates a login and converts pending attendance to present');

  r = await api('/api/logins/welcome?pending=1');
  assert.equal(r.status, 200);
  const welcomes = await r.json();
  const w = welcomes.items.find(x => x.student_id === ayla.id);
  assert.ok(w);
  assert.equal(w.email, 'ayla.qr@test.invalid');
  assert.ok(String(w.temp_password).length >= 12);
  // Sign in with the stored temp password (do not print it)
  const newbie = agent();
  r = await newbie.login('ayla.qr@test.invalid', w.temp_password, '/qeyd/' + tok);
  assert.equal(r.status, 302);
  step('welcome API returns the temp password and it signs in');

  r = await api('/api/logins/welcome/' + w.id + '/sent', { method: 'POST' });
  assert.equal((await r.json()).ok, true);
  r = await api('/api/logins/welcome?pending=1');
  const after = await r.json();
  assert.equal(after.items.find(x => x.id === w.id), undefined);
  step('POST sent drops the welcome row from the pending list');

  // Teacher QR display includes the three Azeri steps
  const display = await admin.text('/admin/attendance/qr/1/week/' + code.week_no);
  assert.match(display, /Kameranızla QR kodu skan edin/);
  assert.match(display, /Hesabınız varsa, daxil olun/);
  assert.match(display, /Yenisinizsə/);
  const print = await admin.text('/admin/attendance/qr/1/week/' + code.week_no + '/print');
  assert.match(print, /Kameranızla QR kodu skan edin/);
  const poster = await admin.req('/admin/attendance/qr/1/week/' + code.week_no + '.svg?poster=1');
  assert.equal(poster.status, 200);
  const svg = await poster.text();
  assert.match(svg, /Kameranızla QR kodu skan edin/);
  step('QR display, print, and poster SVG include the three Azeri steps');

  // Reject drops pending attendance
  const guest2 = agent();
  r = await guest2.post(formPath, { name: 'Murad Qr Test', email: 'murad.qr@test.invalid', whatsapp: '055 333 44 55' }, formPath);
  assert.equal(r.status, 302);
  const muradReq = db.prepare("SELECT * FROM enrollment_requests WHERE email='murad.qr@test.invalid'").get();
  const murad = db.prepare('SELECT * FROM students WHERE id=?').get(muradReq.student_id);
  assert.equal(db.prepare("SELECT source FROM attendance WHERE student_id=?").get(murad.id).source, 'qr-pending');
  r = await admin.post('/admin/enrollments/' + muradReq.id + '/reject', {}, '/admin/enrollments');
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT * FROM attendance WHERE student_id=?').get(murad.id), undefined);
  assert.equal(db.prepare("SELECT review_status FROM enrollment_requests WHERE id=?").get(muradReq.id).review_status, 'rejected');
  step('reject drops the pending attendance mark');

  db.close();
  console.log('qr-self-enroll: all checks passed');
} finally {
  try { srv.child.kill('SIGTERM'); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
