// End-to-end check of homework, late deductions, grades and the email outbox (NO email is ever sent).
// Local:  BASE=http://localhost:3061 HOMEWORK_API_TOKEN=... node test/homework-e2e.mjs   (after npm run seed:demo)
// Live:   also set RESOLVE_IP, ADMIN_EMAIL/ADMIN_PASSWORD, ST_EMAIL/ST_PASSWORD (a @test.invalid account).
import assert from 'node:assert/strict'; import dns from 'node:dns';
const BASE = process.env.BASE || 'http://localhost:3061'; const TOKEN = process.env.HOMEWORK_API_TOKEN;
if (process.env.RESOLVE_IP) { const host = new URL(BASE).hostname; const orig = dns.lookup; dns.lookup = (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } if (h === host) return o && o.all ? cb(null, [{ address: process.env.RESOLVE_IP, family: 4 }]) : cb(null, process.env.RESOLVE_IP, 4); return orig(h, o, cb); }; }
const AE = process.env.ADMIN_EMAIL || 'admin@baku-bible.example', AP = process.env.ADMIN_PASSWORD || 'BakuDemo2026!';
const SE = process.env.ST_EMAIL || 'aysel@student.baku-bible.example', SP = process.env.ST_PASSWORD || 'BakuDemo2026!';
const KEEP = process.env.KEEP_MARKER === '1'; const CLASS = process.env.CLASS || 'THG 101'; const CLASS2 = process.env.CLASS2 || 'ECC 101';
function agent() { const jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (path, opt = {}) => { const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { cookie: ck(), ...(opt.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const text = async p => (await req(p)).text();
  const csrf = async path => (await text(path)).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = async (path, data, from) => req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, text, post, login: (email, pw) => post('/login', { email, password: pw }) }; }
const api = (path, body) => fetch(BASE + '/api/homework' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const step = m => console.log('✓', m);

const admin = agent(); assert.equal((await admin.login(AE, AP)).status, 302); step('admin login');
const st = agent(); assert.equal((await st.login(SE, SP)).status, 302); step('test student login');
const asg = await admin.text('/admin/assignments'); const secId = asg.match(new RegExp('<option value="(\\d+)">' + CLASS))[1];
const outboxBefore = (await admin.text('/admin/outbox')).match(/To:/g)?.length || 0;
// 1. Assignment due ~2 days 1 hour ago (Baku), 50 pts.
const due = new Date(Date.now() + 4 * 3600e3 - 2 * 86400e3 - 3600e3); const d = due.toISOString().slice(0, 10), t = due.toISOString().slice(11, 16);
let r = await admin.post('/admin/assignments', { section_id: secId, title_az: 'TEST — Romalılara 5 esse', due_date: d, due_time: t, max_points: '50', late_policy: '24:5, 72:10, 168:20, *:30', instructions_az: 'TEST tapşırığı' }, '/admin/assignments');
assert.equal(r.status, 302); step('assignment created');
const ob = await admin.text('/admin/outbox'); assert.match(ob, /Yeni tapşırıq: TEST — Romalılara 5 esse/); assert.match(ob, /Pastor Bruce Wright/); assert.match(ob, /OFF \(EMAIL_SENDING_ENABLED|ON</); step('assignment notices queued as pending (not sent)');
// 2. Student sees it in Azeri and submits late (never blocked) + free homework.
const home = await st.text('/telebe'); const aid = [...home.matchAll(/TEST — Romalılara 5 esse[\s\S]*?action="\/telebe\/tapsiriq\/(\d+)"/g)][0][1]; assert.match(home, /Son tarix keçib/); step('student sees assignment');
r = await st.post('/telebe/tapsiriq/' + aid, { body: 'TEST: Mən Romalılara 5-i oxudum. Allahın lütfü bizə sülh verir və biz imanla saleh sayılırıq.' }, '/telebe'); assert.equal(r.status, 302);
r = await st.post('/telebe/tapsiriq', { course_code: CLASS2, title: 'TEST sərbəst', body: 'TEST: Bədən həyatı haqqında qısa fikir.' }, '/telebe'); assert.equal(r.status, 302); step('student submitted late + free homework');
// 3. API.
assert.equal((await fetch(BASE + '/api/homework/needs-draft')).status, 401);
let j = await (await api('/needs-draft')).json(); const item = j.items.find(x => x.title === 'TEST — Romalılara 5 esse'); assert.ok(item);
assert.equal(item.lang, 'az'); assert.equal(item.deduction_pct, 10); assert.ok(item.minutes_late > 2880 && item.minutes_late < 3000); step('API lists it: az, ~2d1h late, −10%');
assert.equal((await api(`/${item.id}/return`, { return_az: 'x' })).status, 409);
assert.equal((await api(`/${item.id}/draft`, { draft_en: 'x' })).status, 400);
assert.equal((await api(`/${item.id}/draft`, { translation_en: 'TEST: I read Romans 5. God\'s grace gives us peace.', draft_en: 'TEST draft: good. Cite verses 1–2.' })).status, 200);
assert.equal((await api(`/${item.id}/return`, { return_az: 'x' })).status, 409); step('return refused before Bruce approves');
let sh = await st.text('/telebe'); assert.doesNotMatch(sh, /TEST draft/);
// 4. Bruce approves (tick required) with raw 45 -> final 40.
const F = 'TEST final: Thank you! Please cite Romans 5:1–2.';
await admin.post(`/admin/homework/anytime/${item.id}/approve`, { final_en: F, raw_score: '45' }, `/admin/homework/anytime/${item.id}`);
assert.equal(((await (await api('/needs-azeri')).json()).items.filter(x => x.id === item.id)).length, 0);
await admin.post(`/admin/homework/anytime/${item.id}/approve`, { final_en: F, raw_score: '45', reviewed: 'yes' }, `/admin/homework/anytime/${item.id}`);
const ap = (await (await api('/needs-azeri')).json()).items.find(x => x.id === item.id); assert.equal(ap.final_en, F); assert.equal(ap.final_score, 40);
assert.match(await admin.text(`/admin/homework/anytime/${item.id}`), /−10% of max = −5 pts/); step('Bruce approval gate + late deduction 45 → 40');
assert.equal((await api(`/${item.id}/return`, { return_az: 'TEST: Təşəkkür edirik! Romalılara 5:1–2 ayələrini göstərin.' })).status, 200);
assert.equal((await api(`/${item.id}/return`, { return_az: 'again' })).status, 409);
sh = await st.text('/telebe'); assert.match(sh, /Romalılara 5:1–2 ayələrini/); assert.match(sh, /Bal: 40 \/ 50/); assert.match(sh, /TEST — Romalılara 5 esse: <b>40<\/b>/); step('Azeri feedback + score visible to student, gradebook updated');
assert.match(await admin.text('/admin/outbox'), /Tapşırığınıza rəy hazırdır: TEST — Romalılara 5 esse/); step('return notice queued as pending (not sent)');
// 5. Grades: exam item with weight 2, comment, weighted average, final course grade.
r = await admin.post('/admin/gradebook', { section_id: secId, title: 'TEST — Exam', max_points: '100', weight: '2', due_date: '' }, '/admin/gradebook'); const gid = r.headers.get('location').split('/').pop();
const gi = await admin.text('/admin/gradebook/' + gid); const sid = gi.match(/name="p_(\d+)"/g).map(x => x.match(/\d+/)[0]);
const rowSid = [...gi.matchAll(/<tr><td>([^<]+)<\/td><td><input[^>]+name="p_(\d+)"/g)].find(m => home.includes(m[1].split(' ')[0]))?.[2] || sid[0];
await admin.post('/admin/gradebook/' + gid, { ['p_' + rowSid]: '70', ['c_' + rowSid]: 'TEST comment: yaxşı iş!' }, '/admin/gradebook/' + gid);
sh = await st.text('/telebe'); assert.match(sh, /Müəllimin qeydi: TEST comment: yaxşı iş!/);
// weighted: homework 40/50 (w1) = 80%, exam 70/100 (w2) => (0.8 + 1.4)/3 = 73.3%
assert.match(sh, new RegExp(CLASS + '</b> — orta bal: <b>73\\.3%')); step('grade comment + weighted average 73.3% shown to student');
const cg = await admin.text('/admin/gradebook/class/' + secId); const enr = [...cg.matchAll(/\/admin\/enrollments\/(\d+)\/final/g)];
const myRow = cg.split('<tr>').find(x => x.includes('73.3%')); const eid = myRow.match(/\/admin\/enrollments\/(\d+)\/final/)[1];
await admin.post(`/admin/enrollments/${eid}/final`, { final_grade: 'TEST-B+', back: '/admin/gradebook/class/' + secId }, '/admin/gradebook/class/' + secId);
assert.match(await st.text('/telebe'), /Yekun qiymət: TEST-B\+/); step('final course grade shown to student');
// 6. Clean up everything this test created.
await admin.post(`/admin/enrollments/${eid}/final`, { final_grade: '' }, '/admin/gradebook/class/' + secId);
await admin.post(`/admin/gradebook/${gid}/delete`, { confirm: 'yes' }, '/admin/gradebook/' + gid);
const al = await admin.text('/admin/homework'); for (const m of al.matchAll(/href="\/admin\/homework\/anytime\/(\d+)"[\s\S]*?<h3>(TEST[^<]*)<\/h3>/g)) await admin.post(`/admin/homework/anytime/${m[1]}/delete`, {}, '/admin/homework');
if (!KEEP) { const a2 = await admin.text('/admin/assignments'); const aId = a2.match(/action="\/admin\/assignments\/(\d+)\/delete"[\s\S]*?$/) && [...a2.matchAll(/TEST — Romalılara 5 esse[\s\S]*?action="\/admin\/assignments\/(\d+)\/delete"/g)][0][1];
  await admin.post(`/admin/assignments/${aId}/delete`, { confirm: 'yes' }, '/admin/assignments'); }
const obl = await admin.text('/admin/outbox'); for (const m of obl.matchAll(/action="\/admin\/outbox\/(\d+)\/edit"[\s\S]*?name="subject" value="([^"]*)"/g)) if (/TEST/.test(m[2]) || /TEST/.test(obl.split(`/admin/outbox/${m[1]}/edit`)[1].slice(0, 2000))) { await admin.post(`/admin/outbox/${m[1]}/discard`, {}, '/admin/outbox'); await admin.post(`/admin/outbox/${m[1]}/delete`, {}, '/admin/outbox'); }
assert.doesNotMatch(await admin.text('/admin/homework'), /TEST sərbəst|TEST — Rom/); assert.doesNotMatch(await admin.text('/admin/gradebook'), /TEST — Exam/);
assert.doesNotMatch(await admin.text('/admin/outbox'), /TEST/); assert.doesNotMatch(await admin.text('/admin/outbox?status=all'), /TEST/);
step('cleaned up test homework, grades, final grade, ' + (KEEP ? 'kept the TEST assignment as a durability marker' : 'assignment') + ', discarded test emails');
console.log('e2e: all checks passed');
