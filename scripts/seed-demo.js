// LOCAL DEVELOPMENT ONLY: wipes the SQLite DB and loads FICTIONAL demo data. Run: npm run seed:demo
// Production boots use scripts/seed.js, which never wipes and never creates sample data.
const fs = require('fs'); const path = require('path');
const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bbi.sqlite');
async function main() {
if (process.env.NODE_ENV === 'production' || process.env.DATABASE_URL) { console.error('seed:demo wipes the database; refusing with NODE_ENV=production or DATABASE_URL set.'); process.exit(1); }
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const bcrypt = require('bcryptjs'); const db = require('../src/db'); const wa = require('../src/whatsapp');
const PW = process.env.DEMO_PASSWORD || 'BakuDemo2026!'; const hash = bcrypt.hashSync(PW, 10);
const seedSampleStudents = process.env.SEED_SAMPLE_STUDENTS !== 'false';
const user = (email, role, name) => db.prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?,?,?,?)').run(email, hash, role, name).lastInsertRowid;
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
db.transaction(() => {
  user('admin@baku-bible.example', 'admin', 'Bruce (Admin, demo)');
  const T = [['Pastor Bruce Wright', 'bruce@baku-bible.example', '+994501110001']]
    .map(([n, e, p]) => db.prepare('INSERT INTO teachers (user_id, name, email, whatsapp_phone) VALUES (?,?,?,?)').run(user(e, 'teacher', n), n, e, p).lastInsertRowid);
  const C = [['THG 101', 'Theology of Grace', 'Lütf İlahiyyatı'], ['ECC 101', 'Body Life', 'Body Life']]
    .map(([c, t, a]) => db.prepare('INSERT INTO courses (code, title, title_az) VALUES (?,?,?)').run(c, t, a).lastInsertRowid);
  const SEC = [[C[0], T[0], 'Bazar ertəsi 18:30', 'Xəzər zalı', 12], [C[1], T[0], 'Cümə axşamı 19:00', 'Qala otağı', 14]]
    .map(([c, t, s, r, cap]) => db.prepare(`INSERT INTO sections (course_id, teacher_id, term, schedule, room, capacity) VALUES (?,?, 'Payız 2026', ?,?,?)`).run(c, t, s, r, cap).lastInsertRowid);
  if (seedSampleStudents) {
    const names = ['Aysel Əliyeva', 'Murad Hüseynov', 'Günay Rzayeva', 'Tural İsmayılov', 'Nərmin Abbasova', 'Orxan Babayev', 'Səbinə Kərimova', 'Elvin Nəsirov', 'Lalə Cəfərova', 'Kamran Səfərov', 'Xədicə Mustafayeva', 'Rəşad Vəliyev', 'Fidan Orucova', 'Emil Sadıqov'];
    const S = names.map((n, i) => { const email = n.split(' ')[0].toLowerCase().replace(/ə/g, 'e').replace(/ı/g, 'i').normalize('NFD').replace(/[^a-z]/g, '') + '@student.baku-bible.example';
      const uid = (i < 3 || i === 4) ? user(email, 'student', n) : null; const phone = i === 13 ? null : `+99455${String(2000000 + i * 1371).padStart(7, '0')}`;
      return db.prepare(`INSERT INTO students (user_id, name, preferred_language, whatsapp_phone, email, status, notes, is_demo) VALUES (?,?,?,?,?,?,?,1)`).run(uid, n, i === 9 ? 'ru' : 'az', phone, email, i === 12 ? 'applicant' : 'active', 'DEMO — fictional student').lastInsertRowid; });
    const enroll = (s, sec) => db.prepare('INSERT INTO enrollments (student_id, section_id) VALUES (?,?)').run(s, sec);
    S.slice(0, 12).forEach((s, i) => { enroll(s, SEC[0]); if (i % 2 === 0 || i >= 4) enroll(s, SEC[1]); });
    enroll(S[13], SEC[1]);
    // 6 weekly sessions per section
    const pattern = { [S[3]]: 'aaaapp', [S[7]]: 'paaapa', [S[5]]: 'paapep', [S[10]]: 'plpaep' };
    for (const sec of SEC) {
      const enrolled = db.prepare('SELECT student_id FROM enrollments WHERE section_id=?').all(sec).map(r => r.student_id);
      for (let w = 6; w >= 1; w--) { const sid = db.prepare('INSERT INTO class_sessions (section_id, session_date, topic) VALUES (?,?,?)').run(sec, day(-7 * w + (sec % 3)), `Həftə ${7 - w}`).lastInsertRowid;
        for (const st of enrolled) { const p = sec === SEC[0] && pattern[st]; const c = p ? p[6 - w] : ((st + w) % 11 === 0 ? 'l' : 'p');
          db.prepare('INSERT INTO attendance (session_id, student_id, status, source) VALUES (?,?,?,?)').run(sid, st, { p: 'present', l: 'late', a: 'absent', e: 'excused' }[c], 'demo'); } } }
    // grade items
    const items = {};
    for (const sec of SEC) { items[sec] = [['Quiz 1', 20, -20], ['Midterm', 100, -6], ['Ev tapşırığı 1', 50, 2]].map(([t, m, d]) => db.prepare('INSERT INTO grade_items (section_id, title, max_points, due_date) VALUES (?,?,?,?)').run(sec, t, m, day(d)).lastInsertRowid);
      const enrolled = db.prepare('SELECT student_id FROM enrollments WHERE section_id=?').all(sec).map(r => r.student_id);
      enrolled.forEach(st => { const weak = st === S[3] || st === S[7];
        db.prepare('INSERT INTO grades (grade_item_id, student_id, points) VALUES (?,?,?)').run(items[sec][0], st, weak ? 11 : 14 + (st % 6));
        if (!(sec === SEC[1] && st % 3 === 0)) db.prepare('INSERT INTO grades (grade_item_id, student_id, points) VALUES (?,?,?)').run(items[sec][1], st, weak ? 58 : 72 + ((st * 7) % 26)); }); }
    // homework
    const A1 = db.prepare('INSERT INTO assignments (section_id, grade_item_id, title_az, instructions_az, due_date) VALUES (?,?,?,?,?)').run(SEC[0], items[SEC[0]][2], 'Dağüstü vəzdə Allahın lütfü', 'Matta 5–7 fəsillərini oxuyun. "Xoşbəxtdirlər" ayələrindən birini seçin, onda Allahın lütfünü necə gördüyünüzü və həyatınıza necə tətbiq etdiyinizi 150–200 sözlə yazın.', day(-3)).lastInsertRowid;
    const A2 = db.prepare('INSERT INTO assignments (section_id, grade_item_id, title_az, instructions_az, due_date) VALUES (?,?,?,?,?)').run(SEC[1], items[SEC[1]][2], 'Həvarilərin İşləri 2:42–47: yerli kilsənin həyatı', 'İlk kilsənin dörd əsas vərdişini təsvir edin və bunları öz icmanızda necə tətbiq etmək olar, yazın.', day(4)).lastInsertRowid;
    const sub = (a, s, b, src) => db.prepare('INSERT INTO submissions (assignment_id, student_id, body, source) VALUES (?,?,?,?)').run(a, s, b, src).lastInsertRowid;
    sub(A1, S[0], 'men "Ürəyi təmiz olanlar xoşbəxtdir" ayəsini seçdim. isa bizə öyrədir ki, Allahı görmək üçün ürəyimiz təmiz olmalıdır. her gün dua edirem ki, Rəbb məni pis fikirlərdən qorusun. bu ayə mənə yaxsi bir yol göstərir.', 'web');
    sub(A1, S[2], 'Mən "Sülh yaradanlar xoşbəxtdirlər" ayəsini seçdim. Ailəmdə və işdə tez-tez mübahisələr olur. Məsih bizi sülh yaratmağa çağırır. Keçən həftə qonşumla barışdım və bu, mənim üçün böyük sevinc oldu. Bu ayə mənə xatırladır ki, sülh yalnız sözlə deyil, əməllə yaranır.', 'web');
    const s3 = sub(A1, S[4], 'Matta 5:7 — "Mərhəmətli olanlar xoşbəxtdirlər". mesih bizə mərhəmət göstərdi, biz də başqalarına göstərməliyik. kilse də kasıblara kömək edirik.', 'whatsapp');
    db.prepare(`UPDATE submissions SET status='returned' WHERE id=?`).run(s3);
    db.prepare(`INSERT INTO corrections (submission_id, final_az, points, approved_by, approved_at) VALUES (?,?,?,1,CURRENT_TIMESTAMP)`).run(s3, 'Hörmətli Nərmin, gözəl fikirdir! Düzəlişlər: «mesih» → «Məsih», «kilse» → «kilsədə». Cümlələri böyük hərflə başlayın. Növbəti dəfə bir nümunə əlavə edin.', 44);
    // WhatsApp demo messages (Azeri + English), some older than Herald's threshold
    const msgs = [
      [-80, '+994552000000', 'Aysel', 'Salam! Bu gün THG 101 dərsinə gələ bilməyəcəm, xəstəyəm. Üzr istəyirəm.'],
      [-60, '+994552004113', 'Tural', 'Salam müəllim, dünən dərsdə iştirak edə bilmədim.'],
      [-30, '+994507778899', 'Samir Əhmədov', 'Salam, yeni tələbə kimi qeydiyyatdan keçmək istəyirəm. Payız semestrinə yer var?'],
      [-20, '+994552002742', 'Günay', 'Ev tapşırığım: Həvarilərin İşləri 2-də ilk kilsə təlimə, şərikliyə, çörək kəsməyə və duaya bağlı idi. Bizim icmada da həftəlik ev qrupları bunu yaşadır.'],
      [-6, '+994501110001', 'Pastor Bruce', 'THG 101 Midterm qiymət: Murad 88 bal'],
      [-3, '+15551230000', 'Daniel (US)', 'Hi! I am a missionary in Baku and would like to register for the Body Life class. Is it taught in English too?'],
      [-1, '+994552006855', 'Orxan', 'Running 15 minutes late to ECC 101 today, traffic on Neftçilər.'],
    ];
    for (const [h, from, name, text] of msgs) { const ts = new Date(Date.now() + h * 3600e3);
      wa.ingest({ object: 'whatsapp_business_account', entry: [{ id: 'DEMO', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ wa_id: from.slice(1), profile: { name } }], messages: [{ id: 'wamid.DEMO' + Math.abs(h) + from.slice(-4), from: from.slice(1), timestamp: String(Math.floor(ts / 1000)), type: 'text', text: { body: text } }] } }] }] }, { demo: true });
      db.prepare(`UPDATE whatsapp_messages SET received_at=? WHERE wa_message_id=?`).run(ts.toISOString().replace('T', ' ').slice(0, 19), 'wamid.DEMO' + Math.abs(h) + from.slice(-4)); }
  }
})();
if (seedSampleStudents) console.log('Seeded demo classes, staff, and sample students.');
else console.log('Seeded demo classes and staff. Sample students skipped (SEED_SAMPLE_STUDENTS=false).');

// Optional real accounts from BBI_EXTRA_USERS (JSON array). Missing or invalid values must not break startup.
try { require('./seed-extra-users')(); } catch (e) { console.error('BBI_EXTRA_USERS: skipped because seeding extra users failed.'); }
}
main().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
