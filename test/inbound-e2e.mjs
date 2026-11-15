// Isolated inbound homework tests (WhatsApp + email) using the TEST class / @test.invalid pattern.
// Usage:  node test/inbound-e2e.mjs
// Spins a local server on a temp SQLite file; never touches DATABASE_URL or the live site.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-inbound-'));
const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.INBOUND_TEST_PORT || '3098';
const BASE = 'http://127.0.0.1:' + PORT;
const INBOUND = 'inbound-test-token-16xx';
const ADMIN_EMAIL = 'admin@test.invalid';
const ADMIN_PW = 'TestAdmin2026!';
const ST_EMAIL = 'aysel@test.invalid';
const ST_PHONE = '+994551001001';
const LONG = ('Bu mətn ev işi kimidir və iki yüz simvoldan uzundur. ').repeat(8);

const seedJs = `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
delete process.env.DATABASE_URL;
const db = require(${JSON.stringify(path.join(root, 'src/db.js'))});
const bcrypt = require('bcryptjs');
const adminHash = bcrypt.hashSync(${JSON.stringify(ADMIN_PW)}, 8);
const stHash = bcrypt.hashSync('TestStudent2026!', 8);
db.transaction(() => {
  db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'admin', 'Test Admin')").run(${JSON.stringify(ADMIN_EMAIL)}, adminHash);
  const tid = db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES ('bruce-test@test.invalid', ?, 'teacher', 'Pastor Bruce Wright')").run(adminHash).lastInsertRowid;
  const teacher = db.prepare("INSERT INTO teachers (user_id, name, email) VALUES (?, 'Pastor Bruce Wright', 'bruce-test@test.invalid')").run(tid).lastInsertRowid;
  db.prepare("INSERT INTO courses (code, title, title_az) VALUES ('TEST 000', 'Test class (not real)', 'Test sinfi (real deyil)')").run();
  const c = db.prepare("SELECT id FROM courses WHERE code='TEST 000'").get();
  const sec = db.prepare("INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?, 'TEST', 5)").run(c.id, teacher).lastInsertRowid;
  const su = db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'student', 'Aysel Test')").run(${JSON.stringify(ST_EMAIL)}, stHash).lastInsertRowid;
  const sid = db.prepare("INSERT INTO students (user_id, name, preferred_language, whatsapp_phone, email, status) VALUES (?, 'Aysel Test', 'az', ?, ?, 'active')").run(su, ${JSON.stringify(ST_PHONE)}, ${JSON.stringify(ST_EMAIL)}).lastInsertRowid;
  db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?,?)').run(sid, sec);
})();
console.log('seeded');
`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seedJs);
const seeded = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (seeded.status !== 0) { console.error(seeded.stdout, seeded.stderr); throw new Error('seed failed'); }

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT,
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-session-secret-inbound-xx',
    DEMO_MODE: 'true',
    NODE_ENV: 'test',
    INBOUND_EMAIL_TOKEN: INBOUND,
    HOMEWORK_API_TOKEN: 'homework-test-token-16x',
    DATABASE_URL: '',
    EMAIL_SENDING_ENABLED: 'false'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });
const stop = () => { try { child.kill('SIGTERM'); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

function waitForUp() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) return resolve(); } catch {}
      if (Date.now() - t0 > 8000) return reject(new Error('server did not start: ' + out));
      setTimeout(tick, 100);
    };
    tick();
  });
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
  const csrf = async p => (await text(p)).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, text, post, login: (email, pw) => post('/login', { email, password: pw }) };
}

const emailApi = (body, token = INBOUND) => fetch(BASE + '/api/inbound-email', { method: 'POST', headers: { authorization: token ? 'Bearer ' + token : '', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const waHook = body => fetch(BASE + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const step = m => console.log('✓', m);

try {
  await waitForUp();
  const health = await (await fetch(BASE + '/healthz')).json();
  assert.equal(health.ok, true); step('server up');

  // Email: 401 without token, 503 is not expected because token is set.
  assert.equal((await emailApi({ from: ST_EMAIL, text: 'hi' }, '')).status, 401);
  assert.equal((await emailApi({ from: ST_EMAIL, text: 'hi' }, 'wrong-token-16xxxx')).status, 401);
  step('inbound-email rejects bad/missing token');

  // Email: unmatched stranger stays in unmatched list, no hw row.
  let r = await emailApi({ from: 'stranger@test.invalid', subject: 'TEST unmatched', text: 'Bu bir test məktubudur, ev tapşırığı deyil kimi görünə bilər amma tələbə deyil.' });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.matched, false); assert.ok(j.unmatched_id);
  step('unmatched email kept, not discarded');

  // Email: matched student, no open assignment yet → needs_assignment, source=email.
  r = await emailApi({ from: 'Aysel Test <' + ST_EMAIL + '>', subject: 'Sərbəst iş', text: 'Mən Romalılara 5-i oxudum. Allahın lütfü bizə sülh verir.' });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.matched, true); assert.equal(j.needs_assignment, true); assert.ok(j.id);
  const emailHwId = j.id;
  step('matched email filed as homework, assignment unknown');

  // WhatsApp: short greeting from the student is inbox-only (not homework).
  r = await waHook({ from: ST_PHONE, name: 'Aysel Test', text: 'Salam, sabah gələcəyəm.' });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.stored, 1); assert.equal(j.filed, 0);
  step('short WhatsApp greeting is not auto-filed');

  // WhatsApp: unknown number with a long homework-like text stays in the inbox.
  r = await waHook({ from: '+994550000099', name: 'Unknown', text: 'tapşırıq: ' + LONG });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.stored, 1); assert.equal(j.filed, 0);
  step('unknown WhatsApp number stays in the inbox');

  // WhatsApp: keyword from the matched student, still no assignment → filed, needs assignment.
  r = await waHook({ from: ST_PHONE, name: 'Aysel Test', text: 'Tapşırıq: Mən Romalılara 5-i oxudum və qısa bir esse yazdım.' });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.filed, 1);
  step('WhatsApp keyword homework auto-filed');

  // WhatsApp: long text (no keyword) also files.
  r = await waHook({ from: ST_PHONE, name: 'Aysel Test', id: 'wa-long-1', text: LONG });
  assert.equal((await r.json()).filed, 1);
  step('WhatsApp long message auto-filed');

  // WhatsApp: image attachment files even with a short caption.
  r = await waHook({ from: ST_PHONE, name: 'Aysel Test', id: 'wa-img-1', text: 'şəkil', media: [{ type: 'image', id: 'MEDIA123', mime: 'image/jpeg', filename: 'page.jpg' }] });
  assert.equal((await r.json()).filed, 1);
  step('WhatsApp image attachment auto-filed');

  // Create one open assignment, then a new email should attach to it.
  const admin = agent();
  assert.equal((await admin.login(ADMIN_EMAIL, ADMIN_PW)).status, 302);
  const asgPage = await admin.text('/admin/assignments');
  const secId = asgPage.match(/<option value="(\d+)">TEST 000/)[1];
  const due = new Date(Date.now() + 4 * 3600e3 + 5 * 86400e3);
  const d = due.toISOString().slice(0, 10), t = due.toISOString().slice(11, 16);
  r = await admin.post('/admin/assignments', { section_id: secId, title_az: 'TEST — Romalılara 5 esse', due_date: d, due_time: t, max_points: '50', late_policy: '24:5, 72:10, 168:20, *:30', instructions_az: 'TEST tapşırığı' }, '/admin/assignments');
  assert.equal(r.status, 302);
  step('TEST assignment created');

  r = await emailApi({ from: ST_EMAIL, subject: 'Ev tapşırığı', text: 'İkinci esse: lütf haqqında qısa fikir.' });
  j = await r.json();
  assert.equal(j.matched, true); assert.equal(j.needs_assignment, false);
  step('email with exactly one open assignment is attached to it');

  // Title mention still wins if we add a second assignment... skip second assign; instead attach the earlier unknown one via the picker.
  const review = await admin.text('/admin/homework/anytime/' + emailHwId);
  assert.match(review, /Email/);
  assert.match(review, /No assignment yet|Pick assignment|Attach assignment/);
  const assignId = review.match(/<option value="(\d+)"[^>]*>TEST 000 · TEST — Romalılara 5 esse/)[1];
  r = await admin.post('/admin/homework/anytime/' + emailHwId + '/assignment', { assignment_id: assignId }, '/admin/homework/anytime/' + emailHwId);
  assert.equal(r.status, 302);
  const after = await admin.text('/admin/homework/anytime/' + emailHwId);
  assert.match(after, /TEST — Romalılara 5 esse/);
  assert.doesNotMatch(after, /No assignment yet/);
  step('admin assignment picker attaches the TEST assignment');

  const list = await admin.text('/admin/homework');
  assert.match(list, /WhatsApp/);
  assert.match(list, /Email/);
  assert.match(list, /unmatched inbound/);
  step('homework list shows source channels and unmatched banner');

  const inbox = await admin.text('/admin/inbound');
  assert.match(inbox, /stranger@test\.invalid/);
  const umId = inbox.match(/action="\/admin\/inbound\/(\d+)\/dismiss"/)[1];
  r = await admin.post('/admin/inbound/' + umId + '/dismiss', {}, '/admin/inbound');
  assert.equal(r.status, 302);
  assert.doesNotMatch(await admin.text('/admin/inbound'), /stranger@test\.invalid/);
  step('unmatched inbound can be dismissed');

  // Cleanup test data in this temp DB (and drop the temp dir in stop()).
  const hwPage = await admin.text('/admin/homework');
  for (const m of hwPage.matchAll(/href="\/admin\/homework\/anytime\/(\d+)"/g)) {
    await admin.post(`/admin/homework/anytime/${m[1]}/delete`, {}, '/admin/homework');
  }
  const a2 = await admin.text('/admin/assignments');
  const aId = [...a2.matchAll(/TEST — Romalılara 5 esse[\s\S]*?action="\/admin\/assignments\/(\d+)\/delete"/g)][0]?.[1];
  if (aId) await admin.post(`/admin/assignments/${aId}/delete`, { confirm: 'yes' }, '/admin/assignments');
  step('cleaned up test homework and assignment in the isolated DB');

  console.log('inbound e2e: all checks passed');
} finally {
  stop();
}
