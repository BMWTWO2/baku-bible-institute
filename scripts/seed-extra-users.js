// Applied after the demo seed. Reads optional BBI_EXTRA_USERS, a JSON array of
// {name, email, role, password_hash, phone?}. Never throws; a bad or missing value is skipped.
const db = require('../src/db');

const ROLES = new Set(['admin', 'teacher', 'student']);

function seedExtraUsers() {
  // BBI_TEST_USERS (same format) is for short-lived, clearly-labeled test accounts with @test.invalid emails.
  // Test accounts no longer listed there are removed on boot, with their homework and queued emails.
  for (const key of ['BBI_EXTRA_USERS', 'BBI_TEST_USERS']) seedFrom(key);
  removeStaleTestUsers();
  removeTestClassIfUnused();
}

function removeStaleTestUsers() {
  let keep = [];
  try { keep = (JSON.parse(process.env.BBI_TEST_USERS || '[]') || []).map(u => String(u.email || '').trim().toLowerCase()); } catch { keep = []; }
  const stale = db.prepare(`SELECT id, email FROM users WHERE email LIKE '%@test.invalid'`).all().filter(u => !keep.includes(u.email));
  for (const u of stale) {
    db.prepare('DELETE FROM hw_submissions WHERE student_email=?').run(u.email);
    try { db.prepare('DELETE FROM email_outbox WHERE to_email=?').run(u.email); } catch {}
    db.prepare('DELETE FROM students WHERE user_id=? OR email=?').run(u.id, u.email);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  }
  if (stale.length) console.log('BBI_TEST_USERS: removed ' + stale.length + ' old test account(s).');
}

function ensureTestClass() {
  db.prepare(`INSERT OR IGNORE INTO courses (code, title, title_az) VALUES ('TEST 000', 'Test class (not real)', 'Test sinfi (real deyil)')`).run();
  const c = db.prepare(`SELECT id FROM courses WHERE code='TEST 000'`).get();
  if (!db.prepare('SELECT 1 FROM sections WHERE course_id=?').get(c.id)) {
    const t = db.prepare(`SELECT id FROM teachers ORDER BY id LIMIT 1`).get();
    db.prepare(`INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?, 'TEST', 5)`).run(c.id, t ? t.id : null);
  }
}

function removeTestClassIfUnused() {
  const c = db.prepare(`SELECT id FROM courses WHERE code='TEST 000'`).get(); if (!c) return;
  if (db.prepare(`SELECT 1 FROM users WHERE email LIKE '%@test.invalid'`).get()) return;
  for (const sec of db.prepare('SELECT id FROM sections WHERE course_id=?').all(c.id)) {
    db.prepare(`DELETE FROM hw_submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE section_id=?) OR course_code='TEST 000'`).run(sec.id);
    try { db.prepare(`DELETE FROM email_outbox WHERE ref IN (SELECT 'assignment:' || id FROM assignments WHERE section_id=?)`).run(sec.id); } catch {}
    db.prepare('DELETE FROM assignments WHERE section_id=?').run(sec.id);
    db.prepare('DELETE FROM grade_items WHERE section_id=?').run(sec.id);
    db.prepare('DELETE FROM sections WHERE id=?').run(sec.id);
  }
  db.prepare('DELETE FROM courses WHERE id=?').run(c.id);
  console.log('BBI_TEST_USERS: removed the TEST 000 class.');
}

function seedFrom(key) {
  const raw = process.env[key];
  if (raw == null || !String(raw).trim()) return;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error(key + ' is not valid JSON; skipping extra users.');
    return;
  }
  if (!Array.isArray(list)) {
    console.error(key + ' must be a JSON array; skipping extra users.');
    return;
  }
  let added = 0;
  for (const item of list) {
    try {
      if (!item || typeof item !== 'object') {
        console.error('BBI_EXTRA_USERS: skipped one entry that was not an object.');
        continue;
      }
      const name = String(item.name || '').trim();
      const email = String(item.email || '').trim().toLowerCase();
      const role = String(item.role || '').trim().toLowerCase();
      const password_hash = String(item.password_hash || '').trim();
      const phone = String(item.whatsapp_phone || item.phone || '').trim() || null;
      if (!name || !email || !password_hash || !ROLES.has(role)) {
        console.error('BBI_EXTRA_USERS: skipped one entry missing name, email, role, or password_hash.');
        continue;
      }
      if (key === 'BBI_TEST_USERS' && !email.endsWith('@test.invalid')) {
        console.error('BBI_TEST_USERS: test accounts must use an @test.invalid email; skipped one.');
        continue;
      }
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      if (existing) continue;
      const uid = db.prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?,?,?,?)')
        .run(email, password_hash, role, name).lastInsertRowid;
      if (role === 'student') {
        const sid = db.prepare(
          `INSERT INTO students (user_id, name, email, whatsapp_phone, status, is_demo) VALUES (?,?,?,?,'active',0)`
        ).run(uid, name, email, phone).lastInsertRowid;
        // Real students join both real classes; test accounts join only the separate TEST 000 class,
        // so real students never see test assignments.
        if (key === 'BBI_TEST_USERS') ensureTestClass();
        const codes = key === 'BBI_TEST_USERS' ? ['TEST 000'] : ['THG 101', 'ECC 101'];
        const sections = db.prepare(`
          SELECT sec.id FROM sections sec
          JOIN courses c ON c.id = sec.course_id
          WHERE c.code IN (${codes.map(() => '?').join(',')})
        `).all(...codes);
        const enroll = db.prepare('INSERT OR IGNORE INTO enrollments (student_id, section_id) VALUES (?,?)');
        for (const sec of sections) enroll.run(sid, sec.id);
      } else if (role === 'teacher') {
        db.prepare('INSERT INTO teachers (user_id, name, email) VALUES (?,?,?)').run(uid, name, email);
      }
      added++;
    } catch {
      console.error('BBI_EXTRA_USERS: failed to add one entry; continuing.');
    }
  }
  if (added) console.log(key + ': added ' + added + ' user(s).');
}

module.exports = seedExtraUsers;
