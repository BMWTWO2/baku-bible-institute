// Temporary homepage quick-enrollment (closes at ENROLLMENT_CLOSES_AT, default end of this week).
// Creates or reuses a roster record (no login yet) and enrolls into THG 101 / ECC 101 when seats remain.
const crypto = require('crypto');
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
addCol('enrollment_requests', 'email', 'TEXT');
addCol('enrollment_requests', 'note', 'TEXT');
addCol('enrollment_requests', 'token', 'TEXT');
addCol('enrollment_requests', 'section_id', 'INTEGER');
addCol('enrollment_requests', 'session_id', 'INTEGER');
addCol('enrollment_requests', 'week_no', 'INTEGER');
addCol('enrollment_requests', 'course_code', 'TEXT');
addCol('enrollment_requests', 'review_status', "TEXT NOT NULL DEFAULT 'received'");
db.exec(`CREATE TABLE IF NOT EXISTS login_welcomes (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  temp_password TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  emailed_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS login_welcomes_emailed ON login_welcomes(emailed_at)`);

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

function findByEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  return db.prepare('SELECT * FROM students WHERE lower(email)=?').get(em)
    || db.prepare('SELECT s.* FROM students s JOIN users u ON u.id=s.user_id WHERE lower(u.email)=?').get(em)
    || null;
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
    notified_at: r.notified_at || null,
    email: r.email || null,
    note: r.note || null,
    token: r.token || null,
    section_id: r.section_id || null,
    session_id: r.session_id || null,
    week_no: r.week_no || null,
    course_code: r.course_code || null,
    review_status: r.review_status || 'received',
    via: (r.source || '').startsWith('QR self-enroll') ? 'qr' : 'homepage'
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
  const src = String((arguments[1] && arguments[1].source) || 'admin-create-login').slice(0, 80);
  storeWelcome({ student_id: st.id, user_id: uid, email: em, name: name || st.name, password: pw, source: src });
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateQr(body) {
  const errors = [];
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) errors.push({ field: 'name', az: 'Zəhmət olmasa adınızı və soyadınızı yazın.', en: 'Please enter your full name.' });
  else if (name.length > 80) errors.push({ field: 'name', az: 'Ad çox uzundur.', en: 'That name is too long.' });
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) errors.push({ field: 'email', az: 'Zəhmət olmasa doğru email ünvanı yazın.', en: 'Please enter a valid email address.' });
  const phone = normalizePhone(body?.whatsapp || body?.whatsapp_phone || body?.phone);
  if (!phone) errors.push({ field: 'whatsapp', az: 'Zəhmət olmasa WhatsApp nömrənizi yazın.', en: 'Please enter your WhatsApp number.' });
  const note = String(body?.note || '').trim().slice(0, 500);
  return { errors, name, email, phone, note };
}

function qrSource(code) {
  return `QR self-enroll · ${code.code} · week ${code.week_no}`;
}

// Self-enroll from a live weekly QR token. Not tied to the homepage form close date.
function submitQr(body, code) {
  const attqr = require('./attqr');
  if (!code || !attqr.isLive(code)) return { ok: false, expired: true };
  if (isHoneypot(body)) return { ok: true, spam: true };
  const v = validateQr(body);
  const values = { name: v.name, email: String(body?.email || ''), whatsapp: String(body?.whatsapp || body?.whatsapp_phone || body?.phone || ''), note: v.note };
  if (v.errors.length) return { ok: false, errors: v.errors, values };

  const existingUser = db.prepare('SELECT id FROM users WHERE lower(email)=?').get(v.email);
  if (existingUser) return { ok: false, has_login: true, values };

  const prior = db.prepare(`SELECT * FROM enrollment_requests WHERE lower(email)=? AND token=? AND review_status='pending'`).get(v.email, code.token);
  if (prior) return { ok: true, already: true, id: prior.id, student_id: prior.student_id };

  return db.transaction(() => {
    let st = findByEmail(v.email) || findByPhone(v.phone);
    const existing = !!st;
    if (st && st.user_id) return { ok: false, has_login: true, values };
    if (st) {
      if (!st.email) db.prepare('UPDATE students SET email=? WHERE id=?').run(v.email, st.id);
      if (!st.phone && v.phone) db.prepare('UPDATE students SET phone=? WHERE id=?').run(v.phone, st.id);
      if (v.phone) db.prepare('UPDATE students SET whatsapp_phone=COALESCE(NULLIF(whatsapp_phone,\'\'), ?) WHERE id=?').run(v.phone, st.id);
      st = db.prepare('SELECT * FROM students WHERE id=?').get(st.id);
    } else {
      const id = db.prepare(`INSERT INTO students (name, preferred_language, phone, whatsapp_phone, email, status, notes, user_id)
        VALUES (?, 'az', ?, ?, ?, 'applicant', ?, NULL)`).run(v.name, v.phone, v.phone, v.email, 'QR self-enroll').lastInsertRowid;
      st = db.prepare('SELECT * FROM students WHERE id=?').get(id);
    }

    const cap = Number(code.capacity || db.prepare('SELECT capacity FROM sections WHERE id=?').get(code.section_id)?.capacity || 20);
    const already = !!db.prepare('SELECT 1 FROM enrollments WHERE student_id=? AND section_id=?').get(st.id, code.section_id);
    const full = !already && seatCount(code.section_id) >= cap;
    const enrolled = [];
    if (!already) {
      db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?,?)').run(st.id, code.section_id);
      enrolled.push(code.code);
    }
    if (!existing) db.prepare(`UPDATE students SET status='active' WHERE id=?`).run(st.id);

    const sid = attqr.sessionFor(code);
    const ex = db.prepare('SELECT * FROM attendance WHERE session_id=? AND student_id=?').get(sid, st.id);
    if (!ex) {
      db.prepare(`INSERT INTO attendance (session_id, student_id, status, note, source) VALUES (?,?, 'present', 'QR self-enroll (pending approval)', 'qr-pending')`).run(sid, st.id);
    }
    // Pending marks must not count toward the attendance grade until approved.
    attqr.recomputeGrades(code.section_id);

    const flag = reviewFlag({ existing, full: full ? [code.code] : [] });
    const r = db.prepare(`INSERT INTO enrollment_requests
      (source, name, phone, whatsapp_phone, email, note, classes, student_id, existing_student, review_flag, enrolled_codes, full_codes, notified, token, section_id, session_id, week_no, course_code, review_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'pending')`)
      .run(qrSource(code), v.name, v.phone, v.phone, v.email, v.note || null, JSON.stringify([code.code]), st.id, existing ? 1 : 0, flag, JSON.stringify(enrolled), JSON.stringify(full ? [code.code] : []),
        code.token, code.section_id, sid, code.week_no, code.code);
    return { ok: true, id: r.lastInsertRowid, student_id: st.id, existing, enrolled, already, full: full ? [code.code] : [], review_flag: flag };
  })();
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
}

function storeWelcome({ student_id, user_id, email, name, password, source }) {
  const em = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  if (!student_id || !EMAIL_RE.test(em) || pw.length < 12) return null;
  // Keep only the latest unset password for this login (older unused rows are replaced).
  db.prepare(`DELETE FROM login_welcomes WHERE student_id=? AND emailed_at IS NULL`).run(student_id);
  const r = db.prepare(`INSERT INTO login_welcomes (student_id, user_id, email, name, temp_password, source) VALUES (?,?,?,?,?,?)`)
    .run(student_id, user_id || null, em, String(name || '').slice(0, 80), pw, String(source || '').slice(0, 80));
  return r.lastInsertRowid;
}

function listWelcomes({ pending } = {}) {
  const rows = pending
    ? db.prepare('SELECT * FROM login_welcomes WHERE emailed_at IS NULL ORDER BY id').all()
    : db.prepare('SELECT * FROM login_welcomes ORDER BY id').all();
  return rows.map(r => ({
    id: r.id,
    student_id: r.student_id,
    user_id: r.user_id,
    email: r.email,
    name: r.name,
    temp_password: r.temp_password,
    source: r.source,
    created_at: r.created_at,
    emailed_at: r.emailed_at || null
  }));
}

function getWelcome(id) {
  const r = db.prepare('SELECT * FROM login_welcomes WHERE id=?').get(id);
  if (!r) return null;
  return { id: r.id, student_id: r.student_id, user_id: r.user_id, email: r.email, name: r.name, source: r.source, created_at: r.created_at, emailed_at: r.emailed_at || null };
}

function markWelcomeSent(id) {
  const r = db.prepare(`UPDATE login_welcomes SET emailed_at=CURRENT_TIMESTAMP WHERE id=? AND emailed_at IS NULL`).run(id);
  return r.changes > 0;
}

function approve(id) {
  const attqr = require('./attqr');
  const raw = db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id);
  if (!raw) return { ok: false, error: 'not found' };
  if (raw.review_status === 'approved') return { ok: true, already: true, student_id: raw.student_id };
  if (raw.review_status === 'rejected') return { ok: false, error: 'This request was already rejected.' };
  if (!(raw.source || '').startsWith('QR self-enroll')) return { ok: false, error: 'Only QR self-enrollment requests are approved here.' };
  return db.transaction(() => {
    let st = raw.student_id ? db.prepare('SELECT * FROM students WHERE id=?').get(raw.student_id) : null;
    if (!st) return { ok: false, error: 'Student record is missing.' };
    if (raw.section_id) db.prepare('INSERT OR IGNORE INTO enrollments (student_id, section_id) VALUES (?,?)').run(st.id, raw.section_id);
    db.prepare(`UPDATE students SET status='active', email=COALESCE(NULLIF(email,\'\'), ?) WHERE id=?`).run(raw.email, st.id);
    st = db.prepare('SELECT * FROM students WHERE id=?').get(st.id);
    let loginCreated = false;
    if (!st.user_id) {
      const email = String(raw.email || st.email || '').trim().toLowerCase();
      const pw = generatePassword();
      const r = createLogin(st.id, { email, password: pw, name: st.name, source: raw.source });
      if (!r.ok) return { ok: false, error: r.error };
      loginCreated = true;
    }
    if (raw.session_id) {
      const att = db.prepare('SELECT * FROM attendance WHERE session_id=? AND student_id=?').get(raw.session_id, st.id);
      if (att && att.source === 'qr-pending') {
        db.prepare(`UPDATE attendance SET source='qr', note='QR check-in (self-enroll approved)' WHERE id=?`).run(att.id);
      } else if (!att) {
        db.prepare(`INSERT INTO attendance (session_id, student_id, status, note, source) VALUES (?,?, 'present', 'QR check-in (self-enroll approved)', 'qr')`).run(raw.session_id, st.id);
      }
      if (raw.section_id) attqr.recomputeGrades(raw.section_id);
    }
    db.prepare(`UPDATE enrollment_requests SET review_status='approved' WHERE id=?`).run(raw.id);
    return { ok: true, student_id: st.id, login_created: loginCreated };
  })();
}

function reject(id) {
  const attqr = require('./attqr');
  const raw = db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id);
  if (!raw) return { ok: false, error: 'not found' };
  if (raw.review_status === 'approved') return { ok: false, error: 'This request was already approved.' };
  if (raw.review_status === 'rejected') return { ok: true, already: true };
  if (!(raw.source || '').startsWith('QR self-enroll')) return { ok: false, error: 'Only QR self-enrollment requests are rejected here.' };
  return db.transaction(() => {
    if (raw.student_id && raw.session_id) {
      db.prepare(`DELETE FROM attendance WHERE student_id=? AND session_id=? AND source='qr-pending'`).run(raw.student_id, raw.session_id);
      if (raw.section_id) attqr.recomputeGrades(raw.section_id);
    }
    const st = raw.student_id ? db.prepare('SELECT * FROM students WHERE id=?').get(raw.student_id) : null;
    if (st && !raw.existing_student && !st.user_id && raw.section_id) {
      const activity = db.prepare(`SELECT
        (SELECT COUNT(*) FROM attendance WHERE student_id=?) att,
        (SELECT COUNT(*) FROM grades WHERE student_id=?) grades,
        (SELECT COUNT(*) FROM hw_submissions WHERE student_id=?) hw,
        (SELECT COUNT(*) FROM submissions WHERE student_id=?) sub`).get(st.id, st.id, st.id, st.id);
      if (!activity.att && !activity.grades && !activity.hw && !activity.sub) {
        const enrolled = JSON.parse(raw.enrolled_codes || '[]');
        for (const code of enrolled) {
          const sec = sectionForCode(code);
          if (sec) db.prepare('DELETE FROM enrollments WHERE student_id=? AND section_id=?').run(st.id, sec.id);
        }
      }
    }
    db.prepare(`UPDATE enrollment_requests SET review_status='rejected' WHERE id=?`).run(raw.id);
    return { ok: true, student_id: raw.student_id };
  })();
}

// discard() should also drop a pending QR attendance mark so a removed request does not linger as present.
const _discard = discard;
discard = function (id) {
  const raw = db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id);
  if (raw && raw.student_id && raw.session_id) {
    db.prepare(`DELETE FROM attendance WHERE student_id=? AND session_id=? AND source='qr-pending'`).run(raw.student_id, raw.session_id);
  }
  return _discard(id);
};

module.exports = {
  COURSES, DEFAULT_CLOSE, digits, normalizePhone, phonesMatch, findByPhone, findByEmail, closeAt, isOpen, closeLabels,
  validate, validateQr, submit, submitQr, get, list, pendingCount, markNotified, discard, approve, reject,
  createLogin, generatePassword, storeWelcome, listWelcomes, getWelcome, markWelcomeSent,
  pageData, rateLimited, resetRateLimit, isHoneypot, sectionForCode, seatCount, qrSource
};
