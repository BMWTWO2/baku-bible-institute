// Compose-form personalization and approval-only queueing. Throwaway local DB only — never the live DB, nothing is sent.
// Run: node test/outbox-compose.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const step = m => console.log('✓', m);

// --- Unit tests (no server) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-compose-unit-'));
  process.env.DB_PATH = path.join(dir, 'bbi.sqlite');
  delete process.env.DATABASE_URL;
  const outbox = require('../src/outbox');

  assert.equal(outbox.normName('  LƏTAFƏT   Test  '), outbox.normName('lətafət test'));
  assert.equal(outbox.normName('İsmayıl Demo'), outbox.normName('ismayıl demo'));
  const nfc = 'Lətafət'.normalize('NFC'), nfd = 'Lətafət'.normalize('NFD');
  assert.equal(outbox.normName(nfc), outbox.normName(nfd));
  step('name match is Unicode-safe and Azeri case/whitespace insensitive');

  const map = outbox.parseOpenings('Lətafət Test | Hörmətli Lətafət, salam!\n\nDaler Test|Salam Daler\nbad line without a pipe\n| ignored\nLətafət Test | second is ignored');
  assert.equal(map.get(outbox.normName('Lətafət Test')), 'Hörmətli Lətafət, salam!');
  assert.equal(map.get(outbox.normName('Daler Test')), 'Salam Daler');
  assert.equal(map.size, 2);
  step('parseOpenings reads Name | text lines and keeps the first match');

  const students = [
    { id: 1, name: 'Lətafət Test', email: 'letafet@test.invalid' },
    { id: 2, name: 'Daler Test', email: 'daler@test.invalid' },
    { id: 3, name: 'Nərgiz Test', email: '' },
    { id: 3, name: 'Nərgiz Test', email: null }, // same student enrolled twice, no email
    { id: 4, name: 'Riad Test', email: 'not-an-email' },
    { id: 5, name: 'Lətafət Test', email: 'letafet@test.invalid' } // duplicate email
  ];
  const body = '{opening}\n\nƏziz {name},\nreminder';
  const openingsText = '  lƏTAFƏT   Test | Hörmətli Lətafət, salam!\n';
  const r = outbox.composeItems(students, { subject: 'Xatırlatma', body, openingsText });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].to, 'letafet@test.invalid');
  assert.equal(r.items[0].text, 'Hörmətli Lətafət, salam!\n\nƏziz Lətafət Test,\nreminder');
  assert.equal(r.items[1].to, 'daler@test.invalid');
  assert.equal(r.items[1].text, '\n\nƏziz Daler Test,\nreminder'); // empty opening fallback
  assert.deepEqual(r.unmatched, ['Daler Test']);
  assert.deepEqual(r.skipped, ['Nərgiz Test', 'Riad Test']);
  const flash = outbox.formatComposeFlash({ n: r.items.length, unmatched: r.unmatched, skipped: r.skipped });
  assert.match(flash, /2 email\(s\) are waiting in the Outbox for your approval — nothing has been sent/);
  assert.match(flash, /No opening matched: Daler Test/);
  assert.match(flash, /Skipped \(no email\): Nərgiz Test, Riad Test/);
  step('composeItems personalizes, lists unmatched openings, skips no/invalid email');

  const none = outbox.composeItems(students.filter(s => s.id === 1), { subject: 'S', body: 'Hello {name} {opening}', openingsText: '' });
  assert.equal(none.items[0].text, 'Hello Lətafət Test ');
  assert.deepEqual(none.unmatched, []);
  step('with no openings textarea, {opening} is blank and unmatched is not reported');
}

// --- HTTP e2e against a throwaway server ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-compose-http-'));
const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.COMPOSE_TEST_PORT || '3096';
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_EMAIL = 'admin@test.invalid';
const ADMIN_PW = 'TestAdmin2026!';

fs.writeFileSync(path.join(dir, 'seed.cjs'), `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
delete process.env.DATABASE_URL;
const db = require(${JSON.stringify(path.join(root, 'src/db.js'))});
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(ADMIN_PW)}, 8);
db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?,?, 'admin', 'Test Admin')").run(${JSON.stringify(ADMIN_EMAIL)}, hash);
const cid = db.prepare("INSERT INTO courses (code, title, title_az) VALUES ('ECC 101', 'Body Life', 'Bədən həyatı')").run().lastInsertRowid;
const sid = db.prepare("INSERT INTO sections (course_id, term, schedule) VALUES (?, 'Fall 2026', 'Mon')").run(cid).lastInsertRowid;
const add = (name, email) => db.prepare("INSERT INTO students (name, email, status) VALUES (?,?, 'active')").run(name, email).lastInsertRowid;
const a = add('Lətafət Test', 'letafet@test.invalid');
const b = add('Daler Test', 'daler@test.invalid');
const c = add('Nərgiz Test', null);
for (const id of [a, b, c]) db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?,?)').run(id, sid);
console.log('section=' + sid);
`);
const seeded = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (seeded.status !== 0) { console.error(seeded.stdout, seeded.stderr); throw new Error('seed failed'); }
const sectionId = (seeded.stdout.match(/section=(\d+)/) || [])[1];
assert.ok(sectionId);

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'test-session-secret-compose-xx', DEMO_MODE: 'true', NODE_ENV: 'test', DATABASE_URL: '', EMAIL_SENDING_ENABLED: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

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
  const post = async (p, body) => {
    const html = await text('/admin/outbox');
    const csrf = csrfFrom(html);
    return req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }) });
  };
  return { req, text, csrfFrom, post };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await wait(100); if (i === 79) throw new Error('server did not start: ' + out); }

  const a = agent();
  const loginHtml = await a.text('/login');
  let r = await a.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: a.csrfFrom(loginHtml), email: ADMIN_EMAIL, password: ADMIN_PW, next: '/admin/outbox' }) });
  assert.equal(r.status, 302);
  const page = await a.text('/admin/outbox');
  assert.match(page, /action="\/admin\/outbox\/compose"/);
  assert.match(page, /name="_csrf"/);
  assert.match(page, /name="section_ids"/);
  assert.match(page, /name="subject"/);
  assert.match(page, /name="body_text"/);
  assert.match(page, /name="channel"/);
  assert.match(page, /value="email"/);
  assert.match(page, /name="openings"/);
  assert.match(page, />Per-student openings</);
  assert.match(page, /Queue in Outbox \(do not send\)/);
  assert.match(page, /ECC 101/);
  step('compose form is on /admin/outbox with csrf, classes, subject, message, channel=email, openings');

  r = await a.post('/admin/outbox/compose', {
    section_ids: sectionId,
    channel: 'email',
    subject: 'Xatırlatma: ev tapşırığının son günü',
    body_text: '{opening}\n\nƏziz {name},\nreminder body',
    openings: '  lƏTAFƏT   Test | Hörmətli Lətafət, salam!'
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/outbox');
  const after = await a.text('/admin/outbox');
  assert.match(after, /2 email\(s\) are waiting in the Outbox for your approval — nothing has been sent/);
  assert.match(after, /No opening matched: Daler Test/);
  assert.match(after, /Skipped \(no email\): Nərgiz Test/);
  assert.match(after, /Hörmətli Lətafət, salam!/);
  assert.match(after, /Əziz Lətafət Test,/);
  assert.match(after, /Əziz Daler Test,/);
  assert.doesNotMatch(after, /Hörmətli Lətafət[\s\S]*Əziz Daler Test/); // Daler's body has no Lətafət opening
  assert.match(after, /pill amber">pending/);
  assert.doesNotMatch(after, /pill green">sent/);
  step('compose queues pending personalized emails and reports unmatched/skipped; nothing sent');

  const q = spawnSync(process.execPath, ['-e', `process.env.DB_PATH=${JSON.stringify(dbPath)};delete process.env.DATABASE_URL;const db=require('./src/db');const rows=db.prepare("SELECT to_email,to_name,status,kind FROM email_outbox ORDER BY id").all();console.log(JSON.stringify(rows));`], { cwd: root, encoding: 'utf8' });
  const rows = JSON.parse(q.stdout.trim().split('\n').pop());
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.status === 'pending' && x.kind === 'notice'));
  assert.equal(rows[0].to_email, 'letafet@test.invalid');
  assert.equal(rows[1].to_email, 'daler@test.invalid');
  step('database has two pending notice rows and no sent rows (sending switch was ON)');

  console.log('ALL PASSED');
} finally { child.kill(); }
