// End-to-end check of the homework flow against a LOCAL server seeded with demo data.
// Usage: BASE=http://localhost:3061 HOMEWORK_API_TOKEN=... node test/homework-e2e.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3061'; const TOKEN = process.env.HOMEWORK_API_TOKEN; const PW = process.env.DEMO_PASSWORD || 'BakuDemo2026!';
function agent() { let jar = {}; const ck = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (path, opt = {}) => { const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { cookie: ck(), ...(opt.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return r; };
  const csrf = async path => { const h = await (await req(path)).text(); return h.match(/name="_csrf" value="([^"]+)"/)[1]; };
  const post = async (path, data, from) => req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrf(from || '/login'), ...data }) });
  return { req, post, login: (email) => post('/login', { email, password: PW }) }; }
const api = (path, body) => fetch(BASE + '/api/homework' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

const admin = agent(); assert.equal((await admin.login('admin@baku-bible.example')).status, 302);
// 1. Bruce creates an assignment that was due 2 days ago (Baku time), 50 points.
const due = new Date(Date.now() + 4 * 3600e3 - 2 * 86400e3 - 3600e3); const d = due.toISOString().slice(0, 10), t = due.toISOString().slice(11, 16);
let r = await admin.post('/admin/assignments', { section_id: '1', title_az: 'TEST — Romalılara 5 esse', due_date: d, due_time: t, max_points: '50', late_policy: '24:5, 72:10, 168:20, *:30', instructions_az: 'Test' }, '/admin/assignments');
assert.equal(r.status, 302); const list = await (await admin.req('/admin/assignments')).text(); assert.match(list, /TEST — Romalılara 5 esse/);
// 2. Student (demo Aysel, enrolled in THG 101) submits late — must NOT be blocked.
const st = agent(); assert.equal((await st.login('aysel@student.baku-bible.example')).status, 302);
const home = await (await st.req('/telebe')).text(); const aid = home.match(/action="\/telebe\/tapsiriq\/(\d+)"[\s\S]*?$/) && [...home.matchAll(/TEST — Romalılara 5 esse[\s\S]*?action="\/telebe\/tapsiriq\/(\d+)"/g)][0][1];
assert.ok(aid, 'assignment visible to student'); assert.match(home, /Son tarix keçib/);
r = await st.post('/telebe/tapsiriq/' + aid, { body: 'Mən Romalılara 5-i oxudum. Allahın lütfü bizə sülh verir və biz imanla saleh sayılırıq.' }, '/telebe'); assert.equal(r.status, 302);
r = await st.post('/telebe/tapsiriq', { course_code: 'ECC 101', title: 'TEST sərbəst', body: 'Bədən həyatı haqqında qısa fikir.' }, '/telebe'); assert.equal(r.status, 302);
// 3. API auth + list needing draft.
assert.equal((await fetch(BASE + '/api/homework/needs-draft')).status, 401);
let j = await (await api('/needs-draft')).json(); const item = j.items.find(x => x.title.startsWith('TEST — Rom')); assert.ok(item);
assert.equal(item.lang, 'az'); assert.equal(item.deduction_pct, 10); assert.ok(item.minutes_late > 2880 && item.minutes_late < 3000, 'about 2 days 1 hour late');
// 4. Return refused before approval; Azeri draft without translation refused.
assert.equal((await api(`/${item.id}/return`, { return_az: 'x' })).status, 409);
assert.equal((await api(`/${item.id}/draft`, { draft_en: 'x' })).status, 400);
assert.equal((await api(`/${item.id}/draft`, { translation_en: 'I read Romans 5. God\'s grace gives us peace and we are justified by faith.', draft_en: 'Thank you! Good summary. Add verse 1 and 2 references.' })).status, 200);
assert.equal((await api(`/${item.id}/return`, { return_az: 'x' })).status, 409, 'still refused while only drafted');
// Student sees nothing of the correction yet.
let sh = await (await st.req('/telebe')).text(); assert.doesNotMatch(sh, /Add verse 1/); assert.doesNotMatch(sh, /Müəllimin rəyi<\/b>/);
// 5. Bruce: approve without the reviewed tick -> saved only, still drafted.
r = await admin.post(`/admin/homework/anytime/${item.id}/approve`, { final_en: 'Thank you, Aysel! Well said. Please cite Romans 5:1–2.', raw_score: '45' }, `/admin/homework/anytime/${item.id}`);
j = await (await api('/needs-azeri')).json(); assert.equal(j.items.length, 0);
r = await admin.post(`/admin/homework/anytime/${item.id}/approve`, { final_en: 'Thank you, Aysel! Well said. Please cite Romans 5:1–2.', raw_score: '45', reviewed: 'yes' }, `/admin/homework/anytime/${item.id}`);
j = await (await api('/needs-azeri')).json(); const ap = j.items.find(x => x.id === item.id); assert.ok(ap); assert.equal(ap.final_en, 'Thank you, Aysel! Well said. Please cite Romans 5:1–2.'); assert.equal(ap.final_score, 40);
const rev = await (await admin.req(`/admin/homework/anytime/${item.id}`)).text(); assert.match(rev, /−10% of max = −5 pts/);
// 6. Azeri return -> returned; second return refused.
assert.equal((await api(`/${item.id}/return`, { return_az: 'Təşəkkür edirik, Aysel! Çox yaxşı yazmısınız. Zəhmət olmasa Romalılara 5:1–2 ayələrini göstərin.' })).status, 200);
assert.equal((await api(`/${item.id}/return`, { return_az: 'again' })).status, 409);
sh = await (await st.req('/telebe')).text(); assert.match(sh, /Romalılara 5:1–2 ayələrini/); assert.match(sh, /Bal: 40 \/ 50/); assert.match(sh, /gecikməyə görə 5 bal, 10%/);
assert.match(sh, /Qiymətlərim[\s\S]*TEST — Romalılara 5 esse: <b>40<\/b>/);
// 7. Status endpoint; then clean up test data.
j = await (await api('/status')).json(); assert.equal(typeof j.counts.returned, 'number');
const adminList = await (await admin.req('/admin/homework')).text(); for (const m of adminList.matchAll(/href="\/admin\/homework\/anytime\/(\d+)"/g)) await admin.post(`/admin/homework/anytime/${m[1]}/delete`, {}, '/admin/homework');
assert.doesNotMatch(await (await admin.req('/admin/homework')).text(), /TEST sərbəst/);
console.log('homework e2e: all checks passed');
