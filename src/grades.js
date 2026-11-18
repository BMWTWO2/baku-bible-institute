// Weighted grading per class (section). Scheme (editable per class, defaults below):
//   Attendance + class participation 55%  (inside it: attendance 50% / participation 50% — "participation_share")
//   Final exam                        25%
//   Written assignments               20%  (split evenly: with 2 assignments, each is worth 10%)
// Each item's percentage (points ÷ max) is multiplied by its share of the 100. Homework items hold the FINAL score
// (after any late deduction), written when the feedback is returned.
// Missing work: ungraded parts are NOT counted as zero in the "running grade" (earned ÷ weight graded so far); the
// admin gradebook also shows "worth so far (of 100)" = the grade if nothing more were earned.
const db = require('./db');
db.exec(`CREATE TABLE IF NOT EXISTS grade_scheme (section_id INTEGER PRIMARY KEY REFERENCES sections(id) ON DELETE CASCADE,
  attendance REAL NOT NULL DEFAULT 55, final_exam REAL NOT NULL DEFAULT 25, homework REAL NOT NULL DEFAULT 20, hw_count INTEGER NOT NULL DEFAULT 2, participation_share REAL NOT NULL DEFAULT 0.5)`);
if (!db.prepare(`PRAGMA table_info(grade_items)`).all().some(x => x.name === 'kind')) db.exec(`ALTER TABLE grade_items ADD COLUMN kind TEXT`);

const DEFAULTS = { attendance: 55, final_exam: 25, homework: 20, hw_count: 2, participation_share: 0.5 };
const KINDS = ['participation', 'final', 'homework', 'other'];            // kinds a teacher may pick ('attendance' is automatic)
const KIND_LABEL = { attendance: 'Attendance (automatic)', participation: 'Participation', final: 'Final exam', homework: 'Written assignment', other: 'Not counted in the weighted grade' };
const CAT = `CASE WHEN gi.kind IS NOT NULL THEN gi.kind WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.grade_item_id=gi.id) THEN 'homework' ELSE 'other' END`;
const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;

function scheme(sectionId) {
  const r = db.prepare('SELECT * FROM grade_scheme WHERE section_id=?').get(sectionId);
  return { ...DEFAULTS, ...(r || {}), custom: !!r };
}
function saveScheme(sectionId, s) {
  db.prepare(`INSERT INTO grade_scheme (section_id, attendance, final_exam, homework, hw_count, participation_share) VALUES (?,?,?,?,?,?)
    ON CONFLICT(section_id) DO UPDATE SET attendance=excluded.attendance, final_exam=excluded.final_exam, homework=excluded.homework, hw_count=excluded.hw_count, participation_share=excluded.participation_share`)
    .run(sectionId, s.attendance, s.final_exam, s.homework, s.hw_count, s.participation_share);
}
function validateScheme(b) {
  const s = { attendance: Number(b.attendance), final_exam: Number(b.final_exam), homework: Number(b.homework), hw_count: Math.round(Number(b.hw_count)), participation_share: Number(b.participation_pct) / 100 };
  if (![s.attendance, s.final_exam, s.homework].every(x => isFinite(x) && x >= 0)) return { error: 'Weights must be numbers ≥ 0.' };
  if (Math.abs(s.attendance + s.final_exam + s.homework - 100) > 0.001) return { error: 'The three weights must add up to 100.' };
  if (!(s.hw_count >= 1 && s.hw_count <= 10)) return { error: 'Number of written assignments must be 1–10.' };
  if (!(s.participation_share >= 0 && s.participation_share <= 1)) return { error: 'Participation share must be 0–100%.' };
  return { s };
}

// Make sure each class has a Participation item and a Final exam item to enter scores into. Returns how many were created.
function ensureItems(sectionId) {
  let n = 0;
  const secs = sectionId ? [{ id: sectionId }] : db.prepare('SELECT id FROM sections').all();
  for (const sec of secs) for (const [kind, title] of [['participation', 'Dərsdə iştirak · Class participation'], ['final', 'Yekun imtahan · Final exam']]) {
    if (!db.prepare('SELECT 1 FROM grade_items WHERE section_id=? AND kind=?').get(sec.id, kind)) { db.prepare('INSERT INTO grade_items (section_id, title, max_points, weight, kind) VALUES (?,?,100,1,?)').run(sec.id, title, kind); n++; } }
  return n;
}

// One student's weighted breakdown for one class, from preloaded items and that student's grade rows.
function compute(sch, items, gmap) {
  const pctOf = it => { const g = gmap.get(it.id); return g && g.points != null && it.max_points > 0 ? 100 * g.points / it.max_points : null; };
  const avg = xs => { xs = xs.filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const by = k => items.filter(i => i.cat === k);
  const att = avg(by('attendance').map(pctOf)), par = avg(by('participation').map(pctOf));
  const ps = sch.participation_share;
  const parts = [[att, 1 - ps], [par, ps]].filter(([v, w]) => v != null && w > 0);
  const apPct = parts.length ? parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0) : null;
  const finalPct = avg(by('final').map(pctOf));
  const hwItems = by('homework').sort((a, b) => String(a.due_date || '~').localeCompare(String(b.due_date || '~')) || a.id - b.id);
  const slots = Math.max(sch.hw_count, hwItems.length), each = sch.homework / slots;
  const comps = [
    { key: 'attendance', weight: sch.attendance, pct: apPct, att, par },
    { key: 'final', weight: sch.final_exam, pct: finalPct },
    ...Array.from({ length: slots }, (_, i) => { const it = hwItems[i]; const g = it && gmap.get(it.id);
      return { key: 'homework', n: i + 1, weight: each, item_id: it ? it.id : null, title: it ? it.title : null, pct: it ? pctOf(it) : null, points: g && g.points != null ? g.points : null, max: it ? it.max_points : null }; })
  ];
  for (const c of comps) c.earned = c.pct == null ? null : c.weight * c.pct / 100;
  const counted = comps.reduce((a, c) => a + (c.pct == null ? 0 : c.weight), 0);
  const earned = comps.reduce((a, c) => a + (c.earned || 0), 0);
  const total = comps.reduce((a, c) => a + c.weight, 0);
  return { comps: comps.map(c => ({ ...c, pct: c.pct == null ? null : r1(c.pct), earned: c.earned == null ? null : r2(c.earned) })),
    running: counted > 0 ? r1(100 * earned / counted) : null,   // grade on what has been graded so far
    counted: r1(counted), earned: r2(earned), total: r1(total),
    ifNoMore: total > 0 ? r1(100 * earned / total) : null,      // grade if nothing further is earned (ungraded = 0)
    att: att == null ? null : r1(att), par: par == null ? null : r1(par) };
}
const itemsOf = sectionId => db.prepare(`SELECT gi.id, gi.title, gi.max_points, gi.due_date, ${CAT} cat FROM grade_items gi WHERE gi.section_id=? AND gi.max_points > 0 ORDER BY gi.id`).all(sectionId);

function averages(studentId) {
  return db.prepare(`SELECT sec.id section_id, c.code, c.title, c.title_az, e.final_grade FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=? ORDER BY c.code`).all(studentId)
    .map(r => { const items = itemsOf(r.section_id); const sch = scheme(r.section_id);
      const gm = new Map(db.prepare(`SELECT g.grade_item_id id, g.points FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE gi.section_id=? AND g.student_id=?`).all(r.section_id, studentId).map(g => [g.id, g]));
      const bd = compute(sch, items, gm); return { ...r, sch, bd, pct: bd.running, n: [...gm.values()].filter(g => g.points != null).length }; });
}
function sectionBoard(sectionId) {
  const items = itemsOf(sectionId); const sch = scheme(sectionId);
  const gm = new Map(); for (const g of db.prepare(`SELECT g.grade_item_id id, g.student_id, g.points FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE gi.section_id=?`).all(sectionId)) { if (!gm.has(g.student_id)) gm.set(g.student_id, new Map()); gm.get(g.student_id).set(g.id, g); }
  const rows = db.prepare(`SELECT s.id, s.name, e.id enrollment_id, e.final_grade FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.section_id=? ORDER BY s.name`).all(sectionId)
    .map(r => { const bd = compute(sch, items, gm.get(r.id) || new Map()); return { ...r, bd, pct: bd.running }; });
  return { sch, items, rows, hwSlots: Math.max(sch.hw_count, items.filter(i => i.cat === 'homework').length) };
}
const sectionAverages = sectionId => sectionBoard(sectionId).rows;
// Share of the final grade one written assignment is worth in this class (e.g. 10).
const hwEach = sectionId => { const s = scheme(sectionId); return r1(s.homework / Math.max(s.hw_count, db.prepare(`SELECT COUNT(*) n FROM grade_items gi WHERE gi.section_id=? AND ${CAT}='homework'`).get(sectionId).n)); };
const fmt = n => n == null ? '—' : String(Math.round(n * 10) / 10).replace('.', ',');
module.exports = { averages, sectionAverages, sectionBoard, scheme, saveScheme, validateScheme, ensureItems, hwEach, fmt, KINDS, KIND_LABEL, DEFAULTS, CAT };
