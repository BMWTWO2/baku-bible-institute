// Applied after the demo seed. Reads optional BBI_EXTRA_USERS, a JSON array of
// {name, email, role, password_hash, phone?}. Never throws; a bad or missing value is skipped.
const db = require('../src/db');

const ROLES = new Set(['admin', 'teacher', 'student']);

function seedExtraUsers() {
  // BBI_TEST_USERS (same format) is for short-lived, clearly-labeled test accounts; clear it to remove them.
  for (const key of ['BBI_EXTRA_USERS', 'BBI_TEST_USERS']) seedFrom(key);
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
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      if (existing) continue;
      const uid = db.prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?,?,?,?)')
        .run(email, password_hash, role, name).lastInsertRowid;
      if (role === 'student') {
        const sid = db.prepare(
          `INSERT INTO students (user_id, name, email, whatsapp_phone, status, is_demo) VALUES (?,?,?,?,'active',0)`
        ).run(uid, name, email, phone).lastInsertRowid;
        const sections = db.prepare(`
          SELECT sec.id FROM sections sec
          JOIN courses c ON c.id = sec.course_id
          WHERE c.code IN ('THG 101', 'ECC 101')
        `).all();
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
