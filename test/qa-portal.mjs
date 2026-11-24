// Homework assignment portal (lesson → 5 questions → answer 3 → review → overview), end to end against a throwaway
// local DB (never the live DB, no email is ever sent). Run: node test/qa-portal.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const require = createRequire(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-qa-')); const dbPath = path.join(dir, 'bbi.sqlite');
const PORT = process.env.QA_TEST_PORT || '3097'; const BASE = 'http://127.0.0.1:' + PORT; const PW = 'QaTest2026!'; const TOKEN = 'qa-test-token-0123456789abcdef'; const INB = 'qa-inbound-token-0123456789abcdef';
const seed = `process.env.DB_PATH=${JSON.stringify(dbPath)}; delete process.env.DATABASE_URL;
const db=require(${JSON.stringify(path.join(root, 'src/db.js'))}); const h=require('bcryptjs').hashSync(${JSON.stringify(PW)},6);
const u=(e,r,n)=>db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run(e,h,r,n).lastInsertRowid;
u('admin@test.invalid','admin','Test Admin'); const tu=u('teacher@test.invalid','teacher','Test Teacher'); const t=db.prepare('INSERT INTO teachers (user_id,name) VALUES (?,?)').run(tu,'Test Teacher').lastInsertRowid;
const c=db.prepare("INSERT INTO courses (code,title,title_az) VALUES ('ECC 101','Body Life','Body Life')").run().lastInsertRowid;
const sec=db.prepare("INSERT INTO sections (course_id,teacher_id,term) VALUES (?,?,'T')").run(c,t).lastInsertRowid;
for (const [e,n] of [['s1@test.invalid','Aysel Test'],['s2@test.invalid','Murad Test']]) { const id=u(e,'student',n);
  const s=db.prepare('INSERT INTO students (user_id,name,email,status) VALUES (?,?,?,?)').run(id,n,e,'active').lastInsertRowid; db.prepare('INSERT INTO enrollments (student_id,section_id) VALUES (?,?)').run(s,sec); }`;
fs.writeFileSync(path.join(dir, 'seed.cjs'), seed);
const sr = spawnSync(process.execPath, [path.join(dir, 'seed.cjs')], { cwd: root, env: { ...process.env, DATABASE_URL: '', NODE_PATH: path.join(root, 'node_modules') }, encoding: 'utf8' });
if (sr.status !== 0) { console.error(sr.stdout, sr.stderr); throw new Error('seed failed'); }
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT, DB_PATH: dbPath, SESSION_SECRET: 'qa-test-secret-xxxxxxxx', DEMO_MODE: 'false', NODE_ENV: 'test', DATABASE_URL: '', HOMEWORK_API_TOKEN: TOKEN, INBOUND_EMAIL_TOKEN: INB, EMAIL_SENDING_ENABLED: 'false', OPENAI_API_KEY: '', WHATSAPP_VERIFY_TOKEN: 'qa-wa-verify-token-xyz', WHATSAPP_APP_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
const agent = () => { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie: ck(), ...(o.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const text = async p => (await req(p)).text();
  const csrf = async p => (await text(p)).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (p, data, from) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, text, post, login: e => post('/login', { email: e, password: PW }) }; };
const api = async (p, body) => { const r = await fetch(BASE + '/api/homework' + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
const email = (from, text, subject = 'Ev tapşırığı') => fetch(BASE + '/api/inbound-email', { method: 'POST', headers: { authorization: 'Bearer ' + INB, 'content-type': 'application/json' }, body: JSON.stringify({ from, subject, text }) }).then(r => r.json());
const step = m => console.log('✓', m);
const Q = [1, 2, 3, 4, 5].map(n => ({ en: `English question ${n}?`, az: `Azərbaycanca sual ${n}?` }));
try {
  for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} if (i > 80) throw new Error('server did not start: ' + out); await new Promise(r => setTimeout(r, 100)); }
  const db = new (require('better-sqlite3'))(dbPath);
  let r = await api('/lessons', { course_code: 'ECC 101', title: 'Testimonies and revival', title_az: 'Şəhadətlər və dirçəliş', session_date: '2026-09-28', source: 'pocket', source_ref: 'Pocket title', source_text: 'Pocket summary text' });
  assert.equal(r.status, 201); const lid = r.j.id; assert.equal(r.j.status, 'needs_summary');
  assert.equal((await api('/lessons', { course_code: 'ECC 101', title: 'x', source: 'pocket', source_ref: 'Pocket title' })).j.existed, true);
  assert.deepEqual((await api('/lessons/needs-summary')).j.items.map(x => x.id), [lid]);
  assert.equal((await api('/lessons/' + lid + '/summary', { summary_en: 'Summary EN', summary_az: 'Xülasə AZ', outline: '- point A\n- point B' })).j.status, 'needs_questions');
  assert.equal((await api('/lessons/' + lid + '/questions', { questions: Q.slice(0, 4) })).status, 400);
  r = await api('/lessons/' + lid + '/questions', { questions: Q }); assert.equal(r.j.published, false); const aid = r.j.assignment_id;
  assert.equal((await api('/lessons/' + lid + '/questions', { questions: Q, publish_test: true })).status, 403);
  step('API: lesson from Pocket → summary → five questions → DRAFT assignment (API cannot publish real classes)');

  const s1 = agent(); await s1.login('s1@test.invalid');
  assert.doesNotMatch(await s1.text('/telebe'), /Şəhadətlər və dirçəliş/); assert.equal((await s1.req('/telebe/tapsiriq/' + aid)).status, 404);
  const pre = await email('Murad <s2@test.invalid>', '1) Draft-time answer'); assert.equal(pre.matched, true); assert.equal(pre.needs_assignment, true);
  step('draft is invisible to students and never matched by inbound email');

  const ad = agent(); await ad.login('admin@test.invalid');
  r = await ad.post('/admin/lessons/' + lid + '/publish', { due_date: '2099-01-01', due_time: '23:59', max_points: '30', late_policy: '' }, '/admin/lessons/' + lid); assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT published FROM assignments WHERE id=?').get(aid).published, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE status='pending' AND ref=?").get('assignment:' + aid).n, 2); assert.equal(db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE status='sent'").get().n, 0);
  step('Bruce publishes on the lesson page; notices wait in the Outbox (none sent)');

  let html = await s1.text('/telebe/tapsiriq/' + aid); assert.match(html, /Azərbaycanca sual 5\?/); assert.match(html, /Xülasə AZ/);
  r = await s1.post('/telebe/tapsiriq/' + aid + '/cavablar', { a1: 'one', a2: 'two' }, '/telebe/tapsiriq/' + aid); assert.match(await s1.text('/telebe/tapsiriq/' + aid), /düz 3 sual/);
  await s1.post('/telebe/tapsiriq/' + aid + '/cavablar', { a1: 'Bir cavab', a3: 'Üç cavab', a5: 'Beş cavab' }, '/telebe/tapsiriq/' + aid);
  const h1 = db.prepare('SELECT id, split_by, source FROM hw_submissions WHERE student_id=1 AND assignment_id=?').get(aid); assert.equal(h1.split_by, 'form');
  assert.deepEqual(db.prepare('SELECT question_n FROM hw_answers WHERE hw_submission_id=?').all(h1.id).map(x => x.question_n), [1, 3, 5]);
  await s1.post('/telebe/tapsiriq/' + aid + '/cavablar', { a1: 'Bir cavab (düzəliş)', a3: 'Üç', a4: 'Dörd' }, '/telebe/tapsiriq/' + aid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM hw_submissions WHERE student_id=1').get().n, 1); assert.deepEqual(db.prepare('SELECT question_n FROM hw_answers WHERE hw_submission_id=?').all(h1.id).map(x => x.question_n), [1, 3, 4]);
  step('student reads Azeri summary, must pick exactly 3; resubmitting before review updates the same submission');

  const e1 = await email('Murad <s2@test.invalid>', 'Salam müəllim\n1) Təcili yardım cavabı\n2-ci sual: güc və səlahiyyət'); const e2 = await email('s2@test.invalid', '4. Hikmət haqqında');
  assert.equal(e1.needs_assignment, false); assert.equal(e2.id, e1.id);
  assert.deepEqual(db.prepare('SELECT question_n FROM hw_answers WHERE hw_submission_id=?').all(e1.id).map(x => x.question_n), [1, 2, 4]);
  step('email answers match the open assignment, two emails merge, question numbers detected (1, 2, 4)');
  db.prepare("UPDATE students SET whatsapp_phone='+994500000002' WHERE id=2").run();
  const w = await (await fetch(BASE + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bbi-token': 'qa-wa-verify-token-xyz' }, body: JSON.stringify({ id: 'wamid.qa1', from: '994500000002', name: 'Murad', text: '5) Yajana' }) })).json();
  assert.equal(w.filed, 1); assert.deepEqual(db.prepare('SELECT question_n FROM hw_answers WHERE hw_submission_id=?').all(e1.id).map(x => x.question_n), [1, 2, 4, 5]);
  assert.match(db.prepare('SELECT answer_flag FROM hw_submissions WHERE id=?').get(e1.id).answer_flag, /answered 4 questions/);
  step('a short numbered WhatsApp message joins the same submission (now 1, 2, 4, 5 — flagged: more than 3)');

  assert.deepEqual((await api('/needs-draft')).j.items.map(x => x.id), [pre.id]);
  const nr = (await api('/needs-review')).j.items; assert.deepEqual(nr.map(x => x.id).sort(), [h1.id, e1.id].sort());
  const it = nr.find(x => x.id === h1.id); assert.equal(it.questions.length, 5); assert.equal(it.lesson.outline, '- point A\n- point B'); assert.equal(it.points_per_question, 10); assert.equal(it.answers_split.length, 3);
  assert.equal(JSON.stringify(nr).includes('@test.invalid'), false);
  step('needs-review gives questions, summary, outline and split answers (no emails); needs-draft skips them');

  const ans = [1, 3, 4].map((q, i) => ({ question: q, answer_text: 'x', answer_en: 'English ' + q, correction_en: 'Grammar ok', content_en: 'Matches point A', alignment: ['strong', 'partial', 'weak'][i], score: [5, 3, 2][i] }));
  assert.equal((await api('/' + h1.id + '/review', { answers: [{ ...ans[0], alignment: 'great' }] })).status, 400);
  r = await api('/' + h1.id + '/review', { answers: ans, note_en: 'Warm work.', by: 'Homework Helper' }); assert.equal(r.status, 200); assert.equal(r.j.suggested_points, 20);
  assert.equal(db.prepare('SELECT status FROM hw_submissions WHERE id=?').get(h1.id).status, 'drafted');
  step('assistant review: per-answer alignment + 1–5 score → suggested 20/30, status drafted');

  const dg = await api('/' + h1.id + '/draft'); assert.equal(dg.status, 200); assert.equal(dg.j.status, 'drafted');
  assert.ok(dg.j.draft_en); assert.ok(dg.j.translation_en); assert.equal(dg.j.student_first_name, 'Aysel');
  assert.equal(JSON.stringify(dg.j).includes('@test.invalid'), false);
  assert.equal((await fetch(BASE + '/api/homework/' + h1.id + '/draft')).status, 401);
  assert.equal((await api('/99999/draft')).status, 404);
  step('GET /:id/draft returns draft_en and translation_en (no email); 401 without token, 404 if missing');

  const letter = dg.j.draft_en + '\nIntro added.';
  const saved = await api('/' + h1.id + '/draft', { translation_en: dg.j.translation_en, draft_en: letter, final_en: letter, by: 'Homework Helper' });
  assert.equal(saved.status, 200); assert.equal(saved.j.status, 'drafted'); assert.equal(saved.j.final_en_saved, true);
  const dg2 = await api('/' + h1.id + '/draft'); assert.equal(dg2.j.status, 'drafted'); assert.equal(dg2.j.draft_en, letter); assert.equal(dg2.j.final_en, letter);
  step('POST /:id/draft can update draft_en and final_en while status stays drafted');

  assert.equal((await api('/' + h1.id + '/approve', { score: 20, dry_run: true })).status, 400);
  assert.equal(db.prepare('SELECT status FROM hw_submissions WHERE id=?').get(h1.id).status, 'drafted');
  const dry = await api('/' + h1.id + '/approve', { score: 20, reviewed: true, dry_run: true });
  assert.equal(dry.status, 200); assert.equal(dry.j.dry_run, true); assert.equal(dry.j.would_write.final_score, 20); assert.equal(dry.j.would_write.status, 'approved_by_bruce');
  assert.equal(db.prepare('SELECT status FROM hw_submissions WHERE id=?').get(h1.id).status, 'drafted');
  step('POST /:id/approve dry_run validates score 20 and rejects a missing reviewed flag; status stays drafted');

  const rep = (await api('/needs-report')).j.items; assert.equal(rep.length, 1); assert.match(rep[0].message_md, /Questions chosen: 1, 3, 4/); assert.match(rep[0].message_md, /20 \/ 30 \(67%\)/); assert.equal(rep[0].student_first_name, 'Aysel');
  assert.equal((await api('/' + h1.id + '/reported', {})).status, 200); assert.equal((await api('/needs-report')).j.items.length, 0);
  assert.equal((await api('/assignments/' + aid + '/overview')).j.submissions.length, 2);
  step('overview for Bruce via API (message_md), marked reported once');

  html = await ad.text('/admin/homework/assignment/' + aid); assert.match(html, /Partial · 3\/5/); assert.match(html, /Matches point A/);
  html = await ad.text('/admin/homework/anytime/' + h1.id); assert.match(html, /Answers by question/); assert.match(html, /value="20"/);
  assert.equal((await ad.req('/admin/lessons')).status, 200); assert.equal((await ad.req('/admin/lessons/' + lid)).status, 200);
  html = await s1.text('/telebe'); assert.doesNotMatch(html, /Matches point A/);
  step('admin overview + review pages show corrections; student sees nothing until Bruce approves');

  html = await s1.text('/telebe/xulaseler'); assert.match(html, /Şəhadətlər və dirçəliş/); assert.equal((await s1.req('/telebe/xulaseler/ders-' + lid)).status, 200);
  assert.equal((await s1.req('/admin/lessons')).status, 403);
  step('published summary appears in Dərs xülasələri; students cannot open admin pages');
  console.log('qa-portal: all checks passed');
} finally { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); }
