// QR attendance check-in. Each class (section) gets ONE fresh, random check-in code per Baku week.
// Week k of the term (k = 1..SESSIONS, default 8) is attendance session k, i.e. one of the 8 columns
// behind the 50-point attendance grade. A rolling window of WINDOW (=5) weekly codes exists at any
// time (this week + the next 4) so the instructor can print ahead; a code only works during its own
// Monday–Sunday Baku week (UTC+4) and stops working when the week ends. As one week ends, the next
// code is added to the window ("five weeks, one new code per week, cycling through").
const crypto = require('crypto'); const QRCode = require('qrcode'); const db = require('./db');

const SESSIONS = Number(process.env.ATTENDANCE_SESSIONS || 8);   // sessions per course (attendance columns)
const POINTS = Number(process.env.ATTENDANCE_POINTS || 50);      // attendance category total
const WINDOW = 5;                                                // weekly codes kept ready ahead
const BAKU_MS = 4 * 3600e3;
const CREDIT = ['present', 'late', 'excused'];                   // statuses that earn the session's points

db.exec(`CREATE TABLE IF NOT EXISTS attendance_codes (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL, token TEXT UNIQUE NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL,
  session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(section_id, week_no))`);
if (!db.prepare(`PRAGMA table_info(grade_items)`).all().some(x => x.name === 'kind')) db.exec(`ALTER TABLE grade_items ADD COLUMN kind TEXT`);

// ---- Baku-time dates (YYYY-MM-DD strings) ----
const bakuDate = (t = Date.now()) => new Date(t + BAKU_MS).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const mondayOf = d => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); return addDays(d, -((wd + 6) % 7)); };
const AZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
const fmtAz = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${AZ_MONTHS[m - 1]} ${y}`; };
const fmtEn = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

const meta = k => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
const setMeta = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
// Term start = Monday of week 1. Set automatically to the current Baku week the first time codes are made.
function termStart() { let s = meta('att_term_start'); if (!s) { s = mondayOf(bakuDate()); setMeta('att_term_start', s); } return s; }
const weekOf = (d = bakuDate()) => Math.floor((Date.parse(d) - Date.parse(termStart())) / (7 * 864e5)) + 1;
const weekRange = k => { const from = addDays(termStart(), 7 * (k - 1)); return { from, until: addDays(from, 6) }; };
const newToken = () => crypto.randomBytes(18).toString('base64url');   // 144 bits, unguessable

const sections = () => db.prepare(`SELECT sec.id, sec.capacity, c.code, c.title, c.title_az, sec.term FROM sections sec JOIN courses c ON c.id=sec.course_id ORDER BY c.code='TEST 000', c.code`).all();
// Make sure this week's code and the next WINDOW-1 weeks' codes exist (never past session SESSIONS). Returns # created.
function ensureWindow() {
  let made = 0; const now = Math.max(1, weekOf());
  const ins = db.prepare('INSERT OR IGNORE INTO attendance_codes (section_id, week_no, token, valid_from, valid_until) VALUES (?,?,?,?,?)');
  db.transaction(() => { for (const s of sections()) for (let k = now; k < now + WINDOW && k <= SESSIONS; k++) { const r = weekRange(k); made += ins.run(s.id, k, newToken(), r.from, r.until).changes; } })();
  for (const s of sections()) ensureGradeItem(s.id);
  return made;
}
const getCode = (sectionId, week) => db.prepare('SELECT * FROM attendance_codes WHERE section_id=? AND week_no=?').get(sectionId, week);
const byToken = t => db.prepare(`SELECT ac.*, c.code, c.title, c.title_az FROM attendance_codes ac JOIN sections sec ON sec.id=ac.section_id JOIN courses c ON c.id=sec.course_id WHERE ac.token=?`).get(String(t || ''));
const isLive = (code, d = bakuDate()) => !!code && d >= code.valid_from && d <= code.valid_until;
function rotate(sectionId, week) { const r = db.prepare('UPDATE attendance_codes SET token=? WHERE section_id=? AND week_no=?').run(newToken(), sectionId, week); return r.changes > 0; }
function window(sectionId) { return db.prepare('SELECT * FROM attendance_codes WHERE section_id=? ORDER BY week_no').all(sectionId).map(c => ({ ...c, live: isLive(c), past: bakuDate() > c.valid_until })); }

// The class_sessions row for a code: created the first time the code is shown or scanned (dated that Baku day).
function sessionFor(code) {
  if (code.session_id && db.prepare('SELECT 1 FROM class_sessions WHERE id=?').get(code.session_id)) return code.session_id;
  const day = isLive(code) ? bakuDate() : code.valid_from; const topic = `Həftə ${code.week_no} · QR`;
  let ses = db.prepare('SELECT id FROM class_sessions WHERE section_id=? AND session_date BETWEEN ? AND ? ORDER BY session_date LIMIT 1').get(code.section_id, code.valid_from, code.valid_until);
  if (!ses) ses = { id: db.prepare('INSERT INTO class_sessions (section_id, session_date, topic) VALUES (?,?,?)').run(code.section_id, day, topic).lastInsertRowid };
  db.prepare('UPDATE attendance_codes SET session_id=? WHERE id=?').run(ses.id, code.id); code.session_id = ses.id; return ses.id;
}

// ---- Scan ----
// Returns { ok, kind, ... } — kind: 'marked' | 'already' | 'teacher_mark' | 'expired' | 'not_yet' | 'invalid' | 'not_student' | 'not_enrolled'
function checkIn(token, user) {
  const code = byToken(token); if (!code) return { ok: false, kind: 'invalid' };
  const d = bakuDate(); if (d > code.valid_until) return { ok: false, kind: 'expired', code }; if (d < code.valid_from) return { ok: false, kind: 'not_yet', code };
  if (!user || user.role !== 'student') return { ok: false, kind: 'not_student', code };
  const st = db.prepare('SELECT * FROM students WHERE user_id=?').get(user.id); if (!st) return { ok: false, kind: 'not_student', code };
  if (!db.prepare('SELECT 1 FROM enrollments WHERE student_id=? AND section_id=?').get(st.id, code.section_id)) return { ok: false, kind: 'not_enrolled', code, student: st };
  return db.transaction(() => {
    const sid = sessionFor(code); const ex = db.prepare('SELECT * FROM attendance WHERE session_id=? AND student_id=?').get(sid, st.id);
    if (ex && ex.source === 'qr') return { ok: true, kind: 'already', code, student: st, at: ex.recorded_at };
    if (ex) return { ok: true, kind: 'teacher_mark', code, student: st, status: ex.status };   // a teacher's manual mark always wins
    db.prepare(`INSERT INTO attendance (session_id, student_id, status, note, source) VALUES (?,?, 'present', 'QR check-in', 'qr')`).run(sid, st.id);
    recomputeGrades(code.section_id);
    return { ok: true, kind: 'marked', code, student: st };
  })();
}

// ---- Live roster for a code ----
function roster(code) {
  const sid = code.session_id;
  const rows = db.prepare(`SELECT s.id, s.name, a.status, a.source, a.recorded_at FROM enrollments e JOIN students s ON s.id=e.student_id
    LEFT JOIN attendance a ON a.student_id=s.id AND a.session_id=? WHERE e.section_id=? AND s.status IN ('active','applicant','paused') ORDER BY s.name`).all(sid || -1, code.section_id);
  const out = rows.map(r => ({ id: r.id, name: r.name, status: r.status || null, source: r.source || null,
    time: r.recorded_at ? new Date(Date.parse(r.recorded_at.replace(' ', 'T') + 'Z') + BAKU_MS).toISOString().slice(11, 16) : null }));
  return { scanned: out.filter(r => r.status && r.source === 'qr'), marked: out.filter(r => r.status && r.source !== 'qr'), missing: out.filter(r => !r.status), total: out.length };
}
function markRestAbsent(code) {
  const sid = sessionFor(code); let n = 0;
  db.transaction(() => { for (const r of roster(code).missing) n += db.prepare(`INSERT OR IGNORE INTO attendance (session_id, student_id, status, note, source) VALUES (?,?, 'absent', 'No QR scan', 'manual')`).run(sid, r.id).changes; recomputeGrades(code.section_id); })();
  return n;
}

// ---- Gradebook: one "Davamiyyət · Attendance" item per class, worth POINTS (50) ----
// Each of the SESSIONS (8) sessions is worth POINTS/SESSIONS (6.25). Present, late and excused earn it; absent earns 0.
// The score is "earned so far": POINTS × credited ÷ sessions held (sessions with any mark, max SESSIONS), so after
// session 8 it equals POINTS × credited ÷ 8. Only students with at least one mark get a score (blank = nothing recorded).
// A score a teacher typed by hand in the gradebook (source='manual') is never overwritten.
function ensureGradeItem(sectionId) {
  let it = db.prepare(`SELECT * FROM grade_items WHERE section_id=? AND kind='attendance'`).get(sectionId);
  if (!it) { const id = db.prepare(`INSERT INTO grade_items (section_id, title, max_points, weight, kind) VALUES (?, 'Davamiyyət · Attendance', ?, 1, 'attendance')`).run(sectionId, POINTS).lastInsertRowid; it = db.prepare('SELECT * FROM grade_items WHERE id=?').get(id); }
  return it;
}
function recomputeGrades(sectionId) {
  const it = ensureGradeItem(sectionId);
  const held = Math.min(SESSIONS, db.prepare(`SELECT COUNT(DISTINCT cs.id) n FROM class_sessions cs JOIN attendance a ON a.session_id=cs.id WHERE cs.section_id=?`).get(sectionId).n);
  if (!held) return 0;
  const rows = db.prepare(`SELECT a.student_id, SUM(a.status IN ('present','late','excused')) credit FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id
    JOIN enrollments e ON e.student_id=a.student_id AND e.section_id=cs.section_id WHERE cs.section_id=? GROUP BY a.student_id`).all(sectionId);
  const up = db.prepare(`INSERT INTO grades (grade_item_id, student_id, points, source) VALUES (?,?,?, 'attendance')
    ON CONFLICT(grade_item_id, student_id) DO UPDATE SET points=excluded.points, updated_at=CURRENT_TIMESTAMP WHERE grades.source<>'manual'`);
  let n = 0; for (const r of rows) n += up.run(it.id, r.student_id, Math.round(100 * it.max_points * Math.min(r.credit, held) / held) / 100).changes;
  return n;
}
const isAttendanceItem = id => db.prepare(`SELECT 1 FROM grade_items WHERE id=? AND kind='attendance'`).get(id);

// ---- QR images (black on white, error correction H, 4-module quiet zone) ----
const QR_OPTS = { errorCorrectionLevel: 'H', margin: 4, color: { dark: '#000000', light: '#ffffff' } };
const png = (url, size = 1200) => QRCode.toBuffer(url, { ...QR_OPTS, type: 'png', width: Math.max(256, Math.min(4096, Number(size) || 1200)) });
const svg = url => QRCode.toString(url, { ...QR_OPTS, type: 'svg' });
const dataUrl = (url, size = 900) => QRCode.toDataURL(url, { ...QR_OPTS, width: size });

module.exports = { SESSIONS, POINTS, WINDOW, CREDIT, bakuDate, fmtAz, fmtEn, termStart, setMeta, mondayOf, weekOf, weekRange, sections, ensureWindow, getCode, byToken, isLive, rotate, window,
  sessionFor, checkIn, roster, markRestAbsent, ensureGradeItem, recomputeGrades, isAttendanceItem, png, svg, dataUrl };
