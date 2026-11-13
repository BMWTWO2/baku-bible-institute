// Boot step (Render start command: `npm run seed && npm start`). NEVER wipes data and NEVER creates
// sample data. In durable mode (DATABASE_URL set) it first restores the newest saved copy of the database.
// Then it makes sure the base records exist (admin, Pastor Bruce Wright, THG 101, ECC 101 Body Life),
// removes any leftover fictional demo rows, and adds real accounts from BBI_EXTRA_USERS.
// For local demo data use `npm run seed:demo` (wipes; refuses in production).
const persist = require('../src/persist');
const clean = e => String(e && e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[db-url]');
async function main() {
  require('fs').rmSync((process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'bbi.sqlite')) + '.persist-ok', { force: true });
  let restored = 'off';
  if (persist.enabled()) restored = await persist.restore(); // throws if Postgres is unreachable: never boot blank in durable mode
  const db = require('../src/db'); const bcrypt = require('bcryptjs');
  const pwHash = () => process.env.BBI_ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.DEMO_PASSWORD || 'BakuDemo2026!', 10);
  db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM users WHERE role='admin'`).get())
      db.prepare(`INSERT INTO users (email, password_hash, role, name) VALUES ('admin@baku-bible.example', ?, 'admin', 'Pastor Bruce Wright (Admin)')`).run(pwHash());
    db.prepare(`UPDATE users SET name='Pastor Bruce Wright (Admin)' WHERE role='admin' AND name LIKE '%demo%'`).run();
    let t = db.prepare(`SELECT id FROM teachers WHERE name='Pastor Bruce Wright'`).get();
    if (!t) { let u = db.prepare(`SELECT id FROM users WHERE email='bruce@baku-bible.example'`).get();
      const uid = u ? u.id : db.prepare(`INSERT INTO users (email, password_hash, role, name) VALUES ('bruce@baku-bible.example', ?, 'teacher', 'Pastor Bruce Wright')`).run(pwHash()).lastInsertRowid;
      t = { id: db.prepare(`INSERT INTO teachers (user_id, name, email) VALUES (?, 'Pastor Bruce Wright', 'bruce@baku-bible.example')`).run(uid).lastInsertRowid }; }
    for (const [code, title, az] of [['THG 101', 'Theology of Grace', 'Lütf İlahiyyatı'], ['ECC 101', 'Body Life', 'Body Life']]) {
      db.prepare(`INSERT INTO courses (code, title, title_az) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET title=excluded.title, title_az=excluded.title_az`).run(code, title, az);
      const c = db.prepare('SELECT id FROM courses WHERE code=?').get(code);
      if (!db.prepare('SELECT 1 FROM sections WHERE course_id=?').get(c.id)) db.prepare(`INSERT INTO sections (course_id, teacher_id, term, capacity) VALUES (?,?, 'Payız 2026', 20)`).run(c.id, t.id);
    }
    // One-time removal of leftover fictional demo rows (never touches real records).
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    if (!db.prepare(`SELECT 1 FROM meta WHERE key='demo_cleanup_v1'`).get()) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('demo_cleanup_v1', datetime('now'))`).run();
    db.prepare(`UPDATE sections SET schedule=NULL, room=NULL WHERE schedule IN ('Bazar ertəsi 18:30','Cümə axşamı 19:00') OR room IN ('Xəzər zalı','Qala otağı')`).run();
    const demoUsers = db.prepare(`SELECT user_id FROM students WHERE is_demo=1 AND user_id IS NOT NULL`).all().map(r => r.user_id);
    db.prepare(`DELETE FROM students WHERE is_demo=1`).run();
    for (const id of demoUsers) db.prepare(`DELETE FROM users WHERE id=? AND role='student'`).run(id);
    db.prepare(`DELETE FROM users WHERE role='student' AND email LIKE '%@student.baku-bible.example'`).run();
    db.prepare(`DELETE FROM whatsapp_messages WHERE is_demo=1`).run();
    db.prepare(`DELETE FROM grade_items WHERE title IN ('Quiz 1','Midterm','Ev tapşırığı 1') AND id NOT IN (SELECT grade_item_id FROM grades WHERE source<>'demo') AND id NOT IN (SELECT grade_item_id FROM assignments WHERE grade_item_id IS NOT NULL AND title_az NOT IN ('Dağüstü vəzdə Allahın lütfü','Həvarilərin İşləri 2:42–47: yerli kilsənin həyatı'))`).run();
    db.prepare(`DELETE FROM assignments WHERE title_az IN ('Dağüstü vəzdə Allahın lütfü','Həvarilərin İşləri 2:42–47: yerli kilsənin həyatı')`).run();
    db.prepare(`DELETE FROM class_sessions WHERE topic LIKE 'Həftə %' AND id NOT IN (SELECT session_id FROM attendance WHERE source<>'demo')`).run();
    }
  })();
  try { require('./seed-extra-users')(); } catch (e) { console.error('BBI_EXTRA_USERS: skipped because seeding extra users failed.'); }
  if (persist.enabled()) { await persist.saveNow(db, 'boot'); persist.markOk(); await persist.close(); }
  console.log(restored === 'restored' ? 'Durable mode: restored the saved database.' : restored === 'empty' ? 'Durable mode: no saved database yet; created base records and saved.' : 'Local mode (no DATABASE_URL): base records ensured; data lives only in the local SQLite file.');
}
main().catch(e => { console.error('Seed failed:', clean(e)); process.exit(1); });
