#!/usr/bin/env node
// Pocket recording → BBI lesson (for the scheduled homework assistant). Never prints any key.
//   node scripts/pocket-lesson.mjs --list "Baku Bible Institute"           list matching recordings (title, Baku date)
//   node scripts/pocket-lesson.mjs --title "Exact title"                   print {title, recorded_at, session_date, summary_markdown} as JSON
//   node scripts/pocket-lesson.mjs --title "Exact title" --course "ECC 101" [--title-az "..."] --post
//        also creates the lesson on the site (POST /api/homework/lessons, status needs_summary; deduplicated by title)
// Config: POCKET_KEY_FILE (default /workspace/fd4g/fd4g-snap/.pocket_api_key), BBI_API_TOKEN_FILE (default .bbi_api_token next to this repo),
//         BBI_BASE (default https://bakubibleinstitute.org), BBI_RESOLVE_IP (optional, e.g. 216.24.57.16 when local DNS is unreliable).
import fs from 'node:fs'; import path from 'node:path'; import dns from 'node:dns'; import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; }; const has = k => process.argv.includes(k);
const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const KEY = read(process.env.POCKET_KEY_FILE || '/workspace/fd4g/fd4g-snap/.pocket_api_key'); if (!KEY) { console.error('No Pocket key file found.'); process.exit(2); }
const BASE = (process.env.BBI_BASE || 'https://bakubibleinstitute.org').replace(/\/$/, '');
if (process.env.BBI_RESOLVE_IP) { const host = new URL(BASE).hostname, ip = process.env.BBI_RESOLVE_IP, orig = dns.lookup;
  dns.lookup = (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } if (h === host) return o && o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4); return orig(h, o, cb); }; }
const P = 'https://public.heypocketai.com/api/v1';
const pget = async (p, n = 1) => { const r = await fetch(P + p, { headers: { authorization: 'Bearer ' + KEY } });
  if ((r.status === 429 || r.status >= 500) && n < 6) { await new Promise(s => setTimeout(s, 800 * 2 ** n)); return pget(p, n + 1); } if (!r.ok) throw new Error('Pocket HTTP ' + r.status); return r.json(); };
async function all() { const out = []; for (let page = 1; page <= 50; page++) { const j = await pget(`/public/recordings?page=${page}&limit=100`); out.push(...(j.data || [])); if (!j.pagination?.has_more) break; } return out; }
const bakuDate = iso => iso ? new Date(Date.parse(iso) + 4 * 3600e3).toISOString().slice(0, 10) : null;
function summaryOf(d) { for (const v of Object.values(d?.summarizations || {})) { if (!v || typeof v !== 'object') continue; const st = v.processingStatus || v.status; if (st && st !== 'completed') continue;
  const md = v?.v2?.summary?.markdown || v?.summary?.markdown || v?.markdown || (typeof v.summary === 'string' ? v.summary : null); if (md && String(md).trim()) return String(md).trim(); } return null; }
const recs = await all();
if (arg('--list') != null) { const q = String(arg('--list')).toLowerCase(); console.log(JSON.stringify(recs.filter(r => String(r.title || '').toLowerCase().includes(q)).map(r => ({ title: r.title, session_date: bakuDate(r.recording_at || r.created_at) })), null, 2)); process.exit(0); }
const title = arg('--title'); if (!title) { console.error('Use --list "words" or --title "Exact title".'); process.exit(2); }
const rec = recs.find(r => r.title === title) || recs.find(r => String(r.title || '').toLowerCase() === title.toLowerCase()); if (!rec) { console.error('No Pocket recording with that exact title.'); process.exit(3); }
const d = (await pget(`/public/recordings/${encodeURIComponent(rec.id)}?include_summarizations=true`)); const det = d.data || d; const md = summaryOf(det);
if (!md) { console.error('That recording has no completed Pocket summary yet.'); process.exit(4); }
const at = det.recording_at || det.created_at || rec.recording_at || rec.created_at || null;
const lesson = { title: rec.title, recorded_at: at, session_date: bakuDate(at), summary_markdown: md };
if (!has('--post')) { console.log(JSON.stringify(lesson, null, 2)); process.exit(0); }
const course = arg('--course'); if (!course) { console.error('--post needs --course "ECC 101" or "THG 101".'); process.exit(2); }
const tok = read(process.env.BBI_API_TOKEN_FILE || path.join(root, '.bbi_api_token')); if (!tok) { console.error('No BBI API token file.'); process.exit(2); }
const r = await fetch(BASE + '/api/homework/lessons', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
  body: JSON.stringify({ course_code: course, title: rec.title, title_az: arg('--title-az') || undefined, session_date: lesson.session_date, source: 'pocket', source_ref: rec.title, source_text: md, by: 'pocket-lesson' }) });
console.log(JSON.stringify({ status: r.status, ...(await r.json()) }));
