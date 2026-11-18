// Weighted grading (55% attendance+participation / 25% final / 2 × 10% assignments), end to end against a throwaway local DB.
// Run: node test/grading.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-grd-')); const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.GRD_TEST_PORT || '3097'; const BASE = 'http://127.0.0.1:' + PORT; const PW = 'GradeTest2026!';
const seed = `process.env.DB_PATH=${JSON.stringify(dbPath)}; delete process.env.DATABASE_URL;
const db=require(${JSON.stringify(path.join(root, 'src/db.js'))}); const grades=require(${JSON.stringify(path.join(root, 'src/grades.js'))}); const h=require('bcryptjs').hashSync(${JSON.stringify(PW)},6);
const u=(e,r,n)=>db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run(e,h,r,n).lastInsertRowid;
u('admin@test.invalid','admin','Test Admin'); const tu=u('teacher@test.invalid','teacher','Test Teacher'); const t=db.prepare('INSERT INTO teachers (user_id,name) VALUES (?,?)').run(tu,'Test Teacher').lastInsertRowid;
const c=db.prepare("INSERT INTO courses (code,title,title_az) VALUES ('THG 101','Theology of Grace','Lütfün İlahiyyatı')").run().lastInsertRowid;
const sec=db.prepare("INSERT INTO sections (course_id,teacher_id,term) VALUES (?,?,'T')").run(c,t).lastInsertRowid;
const stu={}; for (const [e,n] of [['s1@test.invalid','Aysel Test'],['s2@test.invalid','Murad Test']]) { const id=u(e,'student',n);
  const s=db.prepare('INSERT INTO students (user_id,name,email,status) VALUES (?,?,?,?)').run(id,n,e,'active').lastInsertRowid; db.prepare('INSERT INTO enrollments (student_id,section_id) VALUES (?,?)').run(s,sec); stu[e]=s; }
grades.ensureItems(); grades.ensureItems();   // idempotent
const gi=(title,max,kind)=>db.prepare('INSERT INTO grade_items (section_id,title,max_points,kind) VALUES (?,?,?,?)').run(sec,title,max,kind).lastInsertRowid;
const att=gi('Attendance',50,'attendance'); const hw1=gi('HW1',30,null); const hw2=gi('HW2',30,null); const quiz=gi('Quiz',10,null);
for (const g of [hw1,hw2]) db.prepare("INSERT INTO assignments (section_id,grade_item_id,title_az) VALUES (?,?,'x')").run(sec,g);
const part=db.prepare("SELECT id FROM grade_items WHERE section_id=? AND kind='participation'").get(sec).id; const fin=db.prepare("SELECT id FROM grade_items WHERE section_id=? AND kind='final'").get(sec).id;
const set=(i,s,p)=>db.prepare('INSERT INTO grades (grade_item_id,student_id,points) VALUES (?,?,?)').run(i,s,p);
const a=stu['s1@test.invalid'], b=stu['s2@test.invalid'];
set(att,a,40); set(part,a,90); set(fin,a,70); set(hw1,a,24); set(quiz,a,1); set(att,b,50);
console.log(JSON.stringify({ sec, items: db.prepare('SELECT COUNT(*) n FROM grade_items WHERE section_id=?').get(sec).n }));`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seed);
const sr = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (sr.status !== 0) { console.error(sr.stdout, sr.stderr); throw new Error('seed failed'); }
const { sec, items } = JSON.parse(sr.stdout.trim().split('\n').pop()); assert.equal(items, 6, 'participation + final created once each, plus 4 seeded items');
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'grd-test-secret-xxxxxxxx', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
const agent = () => { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    r.cookies = r.headers.getSetCookie?.() || []; for (const c of r.cookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const csrf = async p => (await (await req(p)).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, post, login: e => post('/login', { email: e, password: PW, next: '' }) }; };
const step = m => console.log('✓', m);
try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} if (i > 80) throw new Error('server did not start: ' + out); await new Promise(r => setTimeout(r, 100)); }
  const Db = new (require('better-sqlite3'))(dbPath, { readonly: true });
  const board = id => JSON.parse(spawnSync(process.execPath, ['-e', `process.env.DB_PATH=${JSON.stringify(dbPath)};console.log(JSON.stringify(require('./src/grades.js').sectionBoard(${id})))`], { cwd: root, env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8' }).stdout);
  // Maths (grades.js is loaded against the same DB file read-only via its own handle)
  const bd = board(sec); const A = bd.rows.find(r => r.name === 'Aysel Test').bd, B = bd.rows.find(r => r.name === 'Murad Test').bd;
  assert.deepEqual(bd.sch, { attendance: 55, final_exam: 25, homework: 20, hw_count: 2, participation_share: 0.5, custom: false }); assert.equal(bd.hwSlots, 2);
  assert.equal(A.comps[0].pct, 85); assert.equal(A.comps[0].earned, 46.75); assert.equal(A.comps[1].earned, 17.5); assert.equal(A.comps[2].earned, 8); assert.equal(A.comps[3].pct, null);
  assert.equal(A.earned, 72.25); assert.equal(A.counted, 90); assert.equal(A.total, 100); assert.equal(A.running, 80.3); assert.equal(A.ifNoMore, 72.3);
  step('Aysel: attendance 80% + participation 90% → 85% of 55; final 70% of 25; assignment 24/30 of 10; running 80.3%, 72.3 if nothing more earned; quiz not counted');
  assert.equal(B.comps[0].pct, 100); assert.equal(B.running, 100); assert.equal(B.counted, 55); assert.equal(B.earned, 55); assert.equal(B.ifNoMore, 55);
  step('Murad: attendance only counts as the whole 55% until participation is entered; running grade ignores ungraded parts');

  const anon = agent(); let r = await anon.req('/telebe'); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^\/login/); step('signed-out /telebe redirects to login');
  const s1 = agent(); await s1.login('s1@test.invalid'); r = await s1.req('/telebe'); let html = await r.text(); assert.equal(r.status, 200);
  for (const re of [/Qiymətləndirmə/, /Davamiyyət və dərsdə iştirak/, /55%/, /Yekun imtahan/, /25%/, /2 yazılı tapşırıq — hər biri 10%/, /30 baldır \(3 cavab × 10 bal\)/, /Attendance and class participation/, /Written assignments|written assignments, 10% each/, /Hazırkı nəticəniz: <b>80,3%<\/b>/, /Yazılı tapşırıq 1/, /24 \/ 30 bal/, /hələ yoxdur/])
    assert.match(html, re, 'student page should match ' + re);
  assert.match(html, /Quiz: <b>1<\/b> \/ 10/); assert.doesNotMatch(html, /Müəllimin qeydi: <\/span>/); step('student portal: Azeri + English grading card and per-class breakdown with running result');
  const t = agent(); await t.login('teacher@test.invalid'); r = await t.req('/admin/gradebook/class/' + sec); html = await r.text(); assert.equal(r.status, 200);
  assert.match(html, /Running grade/); assert.match(html, /Assignment 2/); assert.match(html, /80,3%/); assert.match(html, /72,3%/); assert.doesNotMatch(html, /Change this class&#39;s grading scheme/); assert.match(html, /Quiz/);
  r = await t.req('/admin/gradebook'); html = await r.text(); assert.equal(r.status, 200); assert.match(html, /Class participation|Dərsdə iştirak/); assert.match(html, /Final exam/); assert.match(html, /Written assignment/); assert.match(html, /Not counted/);
  step('teacher gradebook: weighted table, categories listed, scheme editor hidden from non-admin');
  const ad = agent(); await ad.login('admin@test.invalid'); const cp = '/admin/gradebook/class/' + sec;
  r = await ad.post(cp + '/scheme', { attendance: 50, final_exam: 25, homework: 20, hw_count: 2, participation_pct: 50 }, cp); assert.equal(r.status, 302);
  assert.equal(Db.prepare('SELECT COUNT(*) n FROM grade_scheme').get().n, 0, 'invalid scheme (sums to 95) must not save');
  r = await ad.post(cp + '/scheme', { attendance: 50, final_exam: 30, homework: 20, hw_count: 2, participation_pct: 40 }, cp); assert.equal(r.status, 302);
  assert.deepEqual(Db.prepare('SELECT attendance a, final_exam f, homework h, hw_count c, participation_share p FROM grade_scheme').get(), { a: 50, f: 30, h: 20, c: 2, p: 0.4 }); step('admin can change a class scheme; weights must add to 100');
  console.log('grading: all checks passed');
} finally { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); }
