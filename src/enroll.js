// Temporary homepage quick-enrollment (closes at ENROLLMENT_CLOSES_AT, default end of this week).
// Creates or reuses a roster record (no login yet) and enrolls into THG 101 / ECC 101 when seats remain.
const db = require('./db');

const COURSES = [
  { code: 'THG 101', title: 'Theology of Grace', title_az: 'Lütf İlahiyyatı' },
  { code: 'ECC 101', title: 'Body Life', title_az: 'Body Life' }
];
const ALLOWED = new Set(COURSES.map(c => c.code));
const DEFAULT_CLOSE = '2026-11-22T23:59:59+04:00';
const RATE_MAX = 8;
const RATE_MS = 15 * 60e3;
const hits = new Map();

db.exec(`CREATE TABLE IF NOT EXISTS enrollment_requests (
  id INTEGER PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'homepage form',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp_phone TEXT,
  classes TEXT NOT NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  existing_student INTEGER NOT NULL DEFAULT 0,
  review_flag TEXT,
  enrolled_codes TEXT,
  full_codes TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS enrollment_requests_notified ON enrollment_requests(notified)`);
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('students', 'phone', 'TEXT');

const digits = s => String(s || '').replace(/\D/g, '');

function normalizePhone(raw) {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  // Common Azerbaijani local form (0XX XXX XX XX) → +994…
  if (d.startsWith('0') && d.length >= 9 && d.length <= 10) d = '994' + d.slice(1);
  if (d.length < 7 || d.length > 15) return null;
  return '+' + d;
}

function phonesMatch(a, b) {
  const da = digits(a), db_ = digits(b);
  if (!da || !db_) return false;
  if (da === db_) return true;
  return da.length >= 9 && db_.length >= 9 && (da.endsWith(db_.slice(-9)) || db_.endsWith(da.slice(-9)));
}

function findByPhone(phone) {
  const want = normalizePhone(phone) || phone;
  if (!digits(want)) return null;
  const rows = db.prepare(`SELECT * FROM students WHERE (phone IS NOT NULL AND phone<>'') OR (whatsapp_phone IS NOT NULL AND whatsapp_phone<>'')`).all();
  return rows.find(r => phonesMatch(r.phone, want) || phonesMatch(r.whatsapp_phone, want)) || null;
}

function closeAt() {
  const raw = String(process.env.ENROLLMENT_CLOSES_AT || DEFAULT_CLOSE).trim();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_CLOSE) : d;
}
function isOpen(now = new Date()) { return now.getTime() <= closeAt().getTime(); }

function closeLabels(d = closeAt()) {
  const opts = { timeZone: 'Asia/Baku', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  const az = new Intl.DateTimeFormat('az-AZ', opts).format(d).replace(',', '') + ' Bakı vaxtı';
  const en = new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'long' }).format(d) + ' Baku time (UTC+4)';
  return { az, en, iso: d.toISOString() };
}

function sectionForCode(code) {
  return db.prepare(`SELECT sec.*, c.code, c.title, c.title_az FROM sections sec JOIN courses c ON c.id=sec.course_id WHERE c.code=? ORDER BY sec.id LIMIT 1`).get(code);
}
function seatCount(sectionId) {
  return db.prepare('SELECT COUNT(*) n FROM enrollments WHERE section_id=?').get(sectionId).n;
}

function selectedCodes(body) {
  const raw = [].concat(body?.classes || []);
  const out = [];
  for (const x of raw) { const c = String(x || '').trim(); if (ALLOWED.has(c) && !out.includes(c)) out.push(c); }
  return out;
}

function validate(body) {
  const errors = [];
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) errors.push({ field: 'name', az: 'Zəhmət olmasa adınızı yazın.', en: 'Please enter your full name.' });
  else if (name.length > 80) errors.push({ field: 'name', az: 'Ad çox uzundur.', en: 'That name is too long.' });
  const phone = normalizePhone(body?.phone);
  if (!phone) errors.push({ field: 'phone', az: 'Zəhmət olmasa doğru telefon nömrəsi yazın.', en: 'Please enter a valid telephone number.' });
  let whatsapp = String(body?.whatsapp || body?.whatsapp_phone || '').trim();
  let whatsappNorm = null;
  if (whatsapp) {
    whatsappNorm = normalizePhone(whatsapp);
    if (!whatsappNorm) errors.push({ field: 'whatsapp', az: 'WhatsApp nömrəsi doğru deyil.', en: 'That WhatsApp number does not look valid.' });
  }
  const codes = selectedCodes(body);
  if (!codes.length) errors.push({ field: 'classes', az: 'Zəhmət olmasa ən azı bir fənn seçin.', en: 'Please choose at least one class.' });
  return { errors, name, phone, whatsapp: whatsappNorm, codes };
}

function rateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const a = hits.get(key) || { n: 0, t: now };
  if (now - a.t > RATE_MS) { a.n = 0; a.t = now; }
  if (a.n >= RATE_MAX) { hits.set(key, a); return true; }
  a.n++; hits.set(key, a); return false;
}
function resetRateLimit() { hits.clear(); }

function isHoneypot(body) {
  return !!(String(body?.website || '').trim() || String(body?.company || '').trim());
}

function reviewFlag({ existing, full }) {
  const parts = [];
  if (existing) parts.push('existing student');
  if (full && full.length) parts.push('class full — needs review');
  return parts.join('; ') || null;
}

function submit(body) {
  if (!isOpen()) return { ok: false, closed: true };
  if (isHoneypot(body)) return { ok: true, spam: true };
  const v = validate(body);
  if (v.errors.length) return { ok: false, errors: v.errors, values: { name: v.name, phone: String(body?.phone || ''), whatsapp: String(body?.whatsapp || body?.whatsapp_phone || ''), classes: v.codes } };
  return db.transaction(() => {
    const waPhone = v.whatsapp || v.phone;
    let st = findByPhone(v.phone) || (v.whatsapp ? findByPhone(v.whatsapp) : null);
    const existing = !!st;
    if (st) {
      if (!st.phone && v.phone) db.prepare('UPDATE students SET phone=? WHERE id=?').run(v.phone, st.id);
      // Fill a missing WhatsApp, or replace the phone-copied default when they later give a different number.
      if (v.whatsapp) db.prepare('UPDATE students SET whatsapp_phone=? WHERE id=?').run(v.whatsapp, st.id);
      else if (!st.whatsapp_phone && waPhone) db.prepare('UPDATE students SET whatsapp_phone=? WHERE id=?').run(waPhone, st.id);
      st = db.prepare('SELECT * FROM students WHERE id=?').get(st.id);
    } else {
      const id = db.prepare(`INSERT INTO students (name, preferred_language, phone, whatsapp_phone, email, status, notes, user_id)
        VALUES (?, 'az', ?, ?, NULL, 'applicant', 'Homepage enrollment form', NULL)`).run(v.name, v.phone, waPhone).lastInsertRowid;
      st = db.prepare('SELECT * FROM students WHERE id=?').get(id);
    }
    const enrolled = [], full = [], already = [];
    for (const code of v.codes) {
      const sec = sectionForCode(code);
      if (!sec) { full.push(code); continue; }
      const prior = db.prepare('SELECT 1 FROM enrollments WHERE student_id=? AND section_id=?').get(st.id, sec.id);
      if (prior) { already.push(code); continue; }
      const cap = Number(sec.capacity || 20);
      if (seatCount(sec.id) >= cap) { full.push(code); continue; }
      db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?,?)').run(st.id, sec.id);
      enrolled.push(code);
    }
    if (!existing) {
      const status = enrolled.length ? 'active' : 'applicant';
      db.prepare('UPDATE students SET status=? WHERE id=?').run(status, st.id);
    }
    const flag = reviewFlag({ existing, full });
    const r = db.prepare(`INSERT INTO enrollment_requests
      (source, name, phone, whatsapp_phone, classes, student_id, existing_student, review_flag, enrolled_codes, full_codes, notified)
      VALUES ('homepage form',?,?,?,?,?,?,?,?,?,0)`)
      .run(v.name, v.phone, waPhone, JSON.stringify(v.codes), st.id, existing ? 1 : 0, flag, JSON.stringify(enrolled), JSON.stringify(full));
    return { ok: true, id: r.lastInsertRowid, student_id: st.id, existing, enrolled, already, full, review_flag: flag };
  })();
}

function serialize(r) {
  if (!r) return null;
  return {
    id: r.id,
    created_at: r.created_at,
    source: r.source,
    name: r.name,
    phone: r.phone,
    whatsapp_phone: r.whatsapp_phone,
    classes: JSON.parse(r.classes || '[]'),
    enrolled: JSON.parse(r.enrolled_codes || '[]'),
    full: JSON.parse(r.full_codes || '[]'),
    student_id: r.student_id,
    existing_student: !!r.existing_student,
    review_flag: r.review_flag,
    notified: !!r.notified,
    notified_at: r.notified_at || null
  };
}

function get(id) { return serialize(db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id)); }

function list({ unnotified } = {}) {
  const rows = unnotified
    ? db.prepare('SELECT * FROM enrollment_requests WHERE notified=0 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM enrollment_requests ORDER BY id DESC').all();
  return rows.map(serialize);
}

function pendingCount() {
  return db.prepare('SELECT COUNT(*) n FROM enrollment_requests WHERE notified=0').get().n;
}

function markNotified(id) {
  const r = db.prepare(`UPDATE enrollment_requests SET notified=1, notified_at=CURRENT_TIMESTAMP WHERE id=? AND notified=0`).run(id);
  return r.changes > 0;
}

// Undo a homepage-form request. Never deletes a student who already has a login or class activity.
// For a new student created by this request: removes the request, the sections this request added, and the student.
// For an existing student: removes only the request and sections this request newly added (not ones they already had).
function discard(id) {
  const raw = db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id);
  if (!raw) return { ok: false, error: 'not found' };
  return db.transaction(() => {
    const st = raw.student_id ? db.prepare('SELECT * FROM students WHERE id=?').get(raw.student_id) : null;
    const enrolled = JSON.parse(raw.enrolled_codes || '[]');
    const undone = [];
    if (st) {
      const activity = db.prepare(`SELECT
        (SELECT COUNT(*) FROM attendance WHERE student_id=?) att,
        (SELECT COUNT(*) FROM grades WHERE student_id=?) grades,
        (SELECT COUNT(*) FROM hw_submissions WHERE student_id=?) hw,
        (SELECT COUNT(*) FROM submissions WHERE student_id=?) sub`).get(st.id, st.id, st.id, st.id);
      const busy = st.user_id || activity.att || activity.grades || activity.hw || activity.sub;
      if (raw.existing_student) {
        if (!busy) {
          for (const code of enrolled) {
            const sec = sectionForCode(code);
            if (!sec) continue;
            const n = db.prepare('DELETE FROM enrollments WHERE student_id=? AND section_id=?').run(st.id, sec.id).changes;
            if (n) undone.push(code);
          }
        }
      } else if (busy) {
        return { ok: false, error: 'student already has a login or class activity; request left in place' };
      } else {
        for (const code of enrolled) {
          const sec = sectionForCode(code);
          if (sec) db.prepare('DELETE FROM enrollments WHERE student_id=? AND section_id=?').run(st.id, sec.id);
        }
        const leftover = db.prepare('SELECT COUNT(*) n FROM enrollments WHERE student_id=?').get(st.id).n;
        if (!leftover) db.prepare('DELETE FROM students WHERE id=? AND user_id IS NULL').run(st.id);
        undone.push(...enrolled);
      }
    }
    db.prepare('DELETE FROM enrollment_requests WHERE id=?').run(raw.id);
    return { ok: true, id: raw.id, student_id: st ? st.id : null, undone };
  })();
}

function createLogin(studentId, { email, password, name } = {}) {
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(studentId);
  if (!st) return { ok: false, error: 'Student not found.' };
  if (st.user_id) return { ok: false, error: 'This student already has a login.' };
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return { ok: false, error: 'A valid email is required for the login.' };
  const pw = String(password || '');
  if (pw.length < 12) return { ok: false, error: 'Password must be at least 12 characters.' };
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(em)) return { ok: false, error: 'That email already has an account.' };
  const bcrypt = require('bcryptjs');
  const uid = db.prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?,?,?,?)')
    .run(em, bcrypt.hashSync(pw, 10), 'student', name || st.name).lastInsertRowid;
  db.prepare('UPDATE students SET user_id=?, email=COALESCE(NULLIF(email,\'\'), ?) WHERE id=?').run(uid, em, st.id);
  return { ok: true, user_id: uid, email: em };
}

function pageData() {
  const labels = closeLabels();
  return {
    open: isOpen(),
    closeAt: labels.iso,
    closeLabelAz: labels.az,
    closeLabelEn: labels.en,
    courses: COURSES.map(c => {
      const sec = sectionForCode(c.code);
      const n = sec ? seatCount(sec.id) : 0;
      const cap = sec ? Number(sec.capacity || 20) : 20;
      return { ...c, section_id: sec?.id || null, taken: n, capacity: cap, remaining: Math.max(0, cap - n) };
    })
  };
}

module.exports = {
  COURSES, DEFAULT_CLOSE, digits, normalizePhone, phonesMatch, findByPhone, closeAt, isOpen, closeLabels,
  validate, submit, get, list, pendingCount, markNotified, discard, createLogin, pageData, rateLimited, resetRateLimit, isHoneypot, sectionForCode, seatCount
};
