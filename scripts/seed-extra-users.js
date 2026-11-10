// Applied after the demo seed. Reads optional BBI_EXTRA_USERS, a JSON array of
// {name, email, role, password_hash}. Never throws; a bad or missing value is skipped.
const db = require('../src/db');

const ROLES = new Set(['admin', 'teacher', 'student']);

function seedExtraUsers() {
  const raw = process.env.BBI_EXTRA_USERS;
  if (raw == null || !String(raw).trim()) return;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error('BBI_EXTRA_USERS is not valid JSON; skipping extra users.');
    return;
  }
  if (!Array.isArray(list)) {
    console.error('BBI_EXTRA_USERS must be a JSON array; skipping extra users.');
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
          `INSERT INTO students (user_id, name, email, status, is_demo) VALUES (?,?,?,'active',0)`
        ).run(uid, name, email).lastInsertRowid;
        const sections = db.prepare(`
          SELECT sec.id FROM sections sec
          JOIN courses c ON c.id = sec.course_id
          WHERE c.title IN ('Theology of Grace', 'Practical Ecclesiology')
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
  if (added) console.log('BBI_EXTRA_USERS: added ' + added + ' user(s).');
}

module.exports = seedExtraUsers;
