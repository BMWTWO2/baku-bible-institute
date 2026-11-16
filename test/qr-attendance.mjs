// QR attendance check-in, end to end against a throwaway local DB (never the live DB). Run: node test/qr-attendance.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-qr-')); const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.QR_TEST_PORT || '3098'; const BASE = 'http://127.0.0.1:' + PORT; const PW = 'QrTest2026!';
const seed = `process.env.DB_PATH=${JSON.stringify(dbPath)}; delete process.env.DATABASE_URL;
const db=require(${JSON.stringify(path.join(root, 'src/db.js'))}); const h=require('bcryptjs').hashSync(${JSON.stringify(PW)},6);
const u=(e,r,n)=>db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run(e,h,r,n).lastInsertRowid;
const tu=u('teacher@test.invalid','teacher','Test Teacher'); const t=db.prepare('INSERT INTO teachers (user_id,name) VALUES (?,?)').run(tu,'Test Teacher').lastInsertRowid;
const c=db.prepare("INSERT INTO courses (code,title) VALUES ('THG 101','Theology of Grace')").run().lastInsertRowid;
const sec=db.prepare("INSERT INTO sections (course_id,teacher_id,term) VALUES (?,?,'T')").run(c,t).lastInsertRowid;
for (const [e,n,enr] of [['s1@test.invalid','Aysel Test',1],['s2@test.invalid','Murad Test',1],['s3@test.invalid','Outsider Test',0]]) { const id=u(e,'student',n);
  const s=db.prepare('INSERT INTO students (user_id,name,email,status) VALUES (?,?,?,?)').run(id,n,e,'active').lastInsertRowid; if (enr) db.prepare('INSERT INTO enrollments (student_id,section_id) VALUES (?,?)').run(s,sec); }`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seed);
const sr = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (sr.status !== 0) { console.error(sr.stdout, sr.stderr); throw new Error('seed failed'); }
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'qr-test-secret-xxxxxxxx', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
const agent = () => { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const csrf = async p => (await (await req(p)).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, post, login: (e, next = '') => post('/login', { email: e, password: PW, next }) }; };
const step = m => console.log('✓', m);
try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} if (i > 80) throw new Error('server did not start: ' + out); await new Promise(r => setTimeout(r, 100)); }
  const db = new (require('better-sqlite3'))(dbPath);
  const codes = db.prepare('SELECT * FROM attendance_codes ORDER BY week_no').all();
  assert.equal(codes.length, 5); assert.equal(codes[0].week_no, 1); assert.ok(codes[0].token.length >= 24); assert.equal(new Set(codes.map(c => c.token)).size, 5);
  step('boot made weeks 1–5 codes with unique random tokens');
  const tok = codes[0].token; const base = '/admin/attendance/qr/1/week/1';

  const anon = agent(); let r = await anon.req('/qeyd/' + tok); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login?next=' + encodeURIComponent('/qeyd/' + tok));
  assert.equal((await anon.req(base + '.png')).status, 302); step('anonymous scan → sign-in with return path; images need sign-in');

  const t = agent(); await t.login('teacher@test.invalid');
  r = await t.req(base); const html = await r.text(); assert.equal(r.status, 200); assert.match(html, /data:image\/png;base64/); assert.match(html, /THG 101/); assert.match(html, /Session 1 of 8/);
  assert.match(html, /Download PNG/); assert.match(html, /Download SVG/); assert.match(html, /Copy image/);
  const png = Buffer.from(await (await t.req(base + '.png?size=1600')).arrayBuffer()); assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), 1600);
  const svg = await (await t.req(base + '.svg')).text(); assert.match(svg, /<svg/);
  assert.equal((await t.req(base + '/print')).status, 200); assert.equal((await t.req('/admin/attendance/qr')).status, 200);
  step('teacher sees display, print, 1600px PNG and SVG');

  const s1 = agent(); r = await s1.login('s1@test.invalid', '/qeyd/' + tok); assert.equal(r.headers.get('location'), '/qeyd/' + tok);
  assert.equal((await s1.req(base)).status, 403); assert.equal((await s1.req(base + '.png')).status, 403);
  r = await s1.req('/qeyd/' + tok); assert.equal(r.status, 200); assert.match(await r.text(), /Davamiyyətiniz qeyd olundu\. Təşəkkür edirik!/);
  r = await s1.req('/qeyd/' + tok); assert.match(await r.text(), /artıq qeyd olunub/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attendance WHERE status='present' AND source='qr'").get().n, 1);
  step('student signs in, returns to check-in, marked present once (idempotent); cannot open teacher pages');

  const ro = await (await t.req(base + '/roster.json')).json(); assert.deepEqual(ro.scanned.map(x => x.name), ['Aysel Test']); assert.deepEqual(ro.missing.map(x => x.name), ['Murad Test']);
  const g = db.prepare("SELECT g.points, g.source, gi.max_points FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE gi.kind='attendance'").all();
  assert.deepEqual(g, [{ points: 50, source: 'attendance', max_points: 50 }]); step('live roster updates; attendance grade item = 50/50 after 1 of 1 sessions');

  const date = db.prepare('SELECT session_date FROM class_sessions').get().session_date;
  await t.post('/admin/attendance', { section_id: '1', date, s_2: 'excused', s_1: 'present' }, '/admin/attendance');
  assert.equal(db.prepare('SELECT source FROM attendance WHERE student_id=1').get().source, 'qr');
  const s2 = agent(); await s2.login('s2@test.invalid'); r = await s2.req('/qeyd/' + tok); assert.match(await r.text(), /müəllim artıq qeyd edib/);
  assert.equal(db.prepare('SELECT status FROM attendance WHERE student_id=2').get().status, 'excused');
  step('teacher manual mark wins over a later scan; re-saving keeps the QR origin');

  const s3 = agent(); await s3.login('s3@test.invalid'); r = await s3.req('/qeyd/' + tok); assert.match(await r.text(), /qeydiyyatda deyilsiniz/);
  r = await s1.req('/qeyd/not-a-real-token'); assert.equal(r.status, 404); assert.match(await r.text(), /tanınmadı/);
  r = await s1.req('/qeyd/' + codes[1].token); assert.match(await r.text(), /hələ aktiv deyil/);
  db.prepare("UPDATE attendance_codes SET valid_from='2020-01-06', valid_until='2020-01-12' WHERE week_no=1").run();
  r = await s1.req('/qeyd/' + tok); assert.equal(r.status, 410); assert.match(await r.text(), /vaxtı bitib/);
  step('friendly Azeri errors: not enrolled, unknown, not yet active, expired');

  db.prepare("UPDATE attendance_codes SET valid_from=date('now','-1 day'), valid_until=date('now','+5 day') WHERE week_no=1").run();
  await t.post(base + '/rotate', {}, base); const nt = db.prepare('SELECT token FROM attendance_codes WHERE week_no=1').get().token; assert.notEqual(nt, tok);
  r = await s1.req('/qeyd/' + tok); assert.equal(r.status, 404); step('rotating a code kills the old QR');
  console.log('qr-attendance: all checks passed');
} finally { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); }
