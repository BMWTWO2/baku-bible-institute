const path = require('path'); const crypto = require('crypto');
const express = require('express'); const session = require('express-session'); const bcrypt = require('bcryptjs');
const db = require('./db'); const wa = require('./whatsapp'); const bots = require('./bots'); const { draftCorrection } = require('./azeri');

const app = express(); const PORT = Number(process.env.PORT || 3050);
const DEMO = process.env.DEMO_MODE != null ? process.env.DEMO_MODE !== 'false' : process.env.NODE_ENV !== 'production';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views')); app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'" }); next(); });
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Webhook (before urlencoded/CSRF). Raw body kept for signature check.
app.get('/webhooks/whatsapp', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && VERIFY_TOKEN && q['hub.verify_token'] === VERIFY_TOKEN) return res.type('text').send(String(q['hub.challenge'] || ''));
  res.sendStatus(403);
});
app.post('/webhooks/whatsapp', express.json({ limit: '1mb', verify: (req, _r, buf) => { req.rawBody = buf; } }), (req, res) => {
  if (APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || ''; const exp = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.sendStatus(401);
  } else if (!DEMO && !(VERIFY_TOKEN && req.get('x-bbi-token') === VERIFY_TOKEN)) return res.sendStatus(401);
  const ids = wa.ingest(req.body); res.json({ ok: true, stored: ids.length });
});

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({ name: 'bbi.sid', secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } }));
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  if (req.method === 'POST' && req.body?._csrf !== req.session.csrf) return res.status(403).send('Invalid CSRF token. Go back, refresh, and try again.');
  res.locals.csrf = req.session.csrf; res.locals.user = req.session.user || null; res.locals.demo = DEMO; res.locals.path = req.path;
  res.locals.flash = req.session.flash; delete req.session.flash; next();
});
const flash = (req, msg) => { req.session.flash = msg; };
const need = (...roles) => (req, res, next) => { const u = req.session.user; if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); if (!roles.includes(u.role)) return res.status(403).render('error', { title: 'Not allowed', msg: 'Your account cannot open this page.' }); next(); };
const audit = (req, action, detail) => db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(req.session.user?.id || null, action, JSON.stringify(detail || {}));
const sectionsList = () => db.prepare(`SELECT sec.*, c.code, c.title, c.title_az, t.name teacher FROM sections sec JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id ORDER BY c.code`).all();

// Public
app.get('/healthz', (_q, res) => res.json({ ok: true, app: 'baku-bible-institute', db: db.prepare('SELECT 1 ok').get().ok === 1, demo: DEMO }));
app.get('/', (req, res) => res.render('home', { title: 'Baku Bible Institute', stats: { students: db.prepare(`SELECT COUNT(*) n FROM students WHERE status='active'`).get().n, courses: db.prepare('SELECT COUNT(*) n FROM courses').get().n } }));
app.get('/login', (req, res) => res.render('login', { title: 'Sign in', error: null, next: req.query.next || '' }));
const attempts = new Map();
app.post('/login', (req, res) => {
  const key = req.ip; const a = attempts.get(key) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).render('login', { title: 'Sign in', error: 'Too many attempts. Wait 15 minutes.', next: '' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) { a.n++; attempts.set(key, a); return res.status(401).render('login', { title: 'Sign in', error: 'Email or password is incorrect.', next: req.body.next || '' }); }
  attempts.delete(key);
  req.session.regenerate(() => { req.session.user = { id: u.id, name: u.name, role: u.role, email: u.email }; const n = String(req.body.next || '');
    res.redirect(n.startsWith('/') && !n.startsWith('//') ? n : u.role === 'student' ? '/telebe' : u.role === 'teacher' ? '/admin/attendance' : '/admin'); });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Admin dashboard
const A = need('admin'); const T = need('admin', 'teacher');
app.get('/admin', A, (req, res) => { const r = bots.weeklyReport(); res.render('admin/dashboard', { title: 'Dashboard', r, bots: bots.BOTS,
  recentWa: db.prepare(`SELECT * FROM whatsapp_messages ORDER BY received_at DESC LIMIT 5`).all() }); });

// Students
app.get('/admin/students', A, (req, res) => {
  const flags = new Map(bots.unexcused().filter(x => x.n > 2).map(x => [x.id, x]));
  const students = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.student_id=s.id) classes FROM students s ORDER BY s.status='applicant' DESC, s.name`).all().map(s => ({ ...s, flag: flags.get(s.id) }));
  res.render('admin/students', { title: 'Roster', students });
});
app.post('/admin/students', A, (req, res) => { const b = req.body; if (!b.name?.trim()) { flash(req, 'Name is required.'); return res.redirect('/admin/students'); }
  const r = db.prepare('INSERT INTO students (name, preferred_language, whatsapp_phone, email, status, notes) VALUES (?,?,?,?,?,?)').run(b.name.trim(), b.preferred_language || 'az', b.whatsapp_phone || null, b.email || null, b.status || 'applicant', b.notes || null);
  audit(req, 'student.create', { id: r.lastInsertRowid }); flash(req, 'Student added.'); res.redirect('/admin/students/' + r.lastInsertRowid); });
app.get('/admin/students/:id', A, (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id); if (!s) return res.status(404).render('error', { title: 'Not found', msg: 'No such student.' });
  res.render('admin/student', { title: s.name, s, sections: sectionsList(),
    enr: db.prepare(`SELECT e.*, c.code, c.title, sec.id section_id FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=?`).all(s.id),
    att: db.prepare(`SELECT a.*, cs.session_date, c.code FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN sections sec ON sec.id=cs.section_id JOIN courses c ON c.id=sec.course_id WHERE a.student_id=? ORDER BY cs.session_date DESC`).all(s.id),
    grades: db.prepare(`SELECT g.*, gi.title, gi.max_points, c.code FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE g.student_id=?`).all(s.id),
    msgs: db.prepare(`SELECT * FROM whatsapp_messages WHERE student_id=? ORDER BY received_at DESC`).all(s.id) });
});
app.post('/admin/students/:id', A, (req, res) => { const b = req.body;
  db.prepare('UPDATE students SET name=?, preferred_language=?, whatsapp_phone=?, email=?, status=?, notes=? WHERE id=?').run(b.name, b.preferred_language || 'az', b.whatsapp_phone || null, b.email || null, b.status, b.notes || null, req.params.id);
  audit(req, 'student.update', { id: req.params.id }); flash(req, 'Saved.'); res.redirect('/admin/students/' + req.params.id); });
app.post('/admin/students/:id/enroll', A, (req, res) => { db.prepare('INSERT OR IGNORE INTO enrollments (student_id, section_id) VALUES (?,?)').run(req.params.id, req.body.section_id); flash(req, 'Enrolled.'); res.redirect('/admin/students/' + req.params.id); });

// Classes
app.get('/admin/classes', T, (req, res) => res.render('admin/classes', { title: 'Classes', sections: db.prepare(`SELECT sec.*, c.code, c.title, c.title_az, t.name teacher, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id=sec.id) n FROM sections sec JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id ORDER BY c.code`).all() }));

// Attendance
app.get('/admin/attendance', T, (req, res) => {
  const sections = sectionsList(); const sid = Number(req.query.section || sections[0]?.id); const date = req.query.date || new Date().toISOString().slice(0, 10);
  const roster = db.prepare(`SELECT s.id, s.name, (SELECT a.status FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE cs.section_id=? AND cs.session_date=? AND a.student_id=s.id) status FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.section_id=? ORDER BY s.name`).all(sid, date, sid);
  const all = bots.unexcused(); res.render('admin/attendance', { title: 'Attendance', sections, sid, date, roster, flags: all.filter(x => x.n > 2), watch: all.filter(x => x.n === 2) });
});
const markAtt = (section_id, date, student_id, status, note, source) => {
  db.prepare('INSERT OR IGNORE INTO class_sessions (section_id, session_date) VALUES (?,?)').run(section_id, date);
  const ses = db.prepare('SELECT id FROM class_sessions WHERE section_id=? AND session_date=?').get(section_id, date);
  db.prepare(`INSERT INTO attendance (session_id, student_id, status, note, source) VALUES (?,?,?,?,?) ON CONFLICT(session_id, student_id) DO UPDATE SET status=excluded.status, note=excluded.note, source=excluded.source, recorded_at=CURRENT_TIMESTAMP`).run(ses.id, student_id, status, note || null, source);
};
const ST = ['present', 'late', 'absent', 'excused'];
app.post('/admin/attendance', T, (req, res) => { const { section_id, date } = req.body;
  for (const [k, v] of Object.entries(req.body)) if (k.startsWith('s_') && ST.includes(v)) markAtt(section_id, date, Number(k.slice(2)), v, null, 'manual');
  audit(req, 'attendance.mark', { section_id, date }); flash(req, 'Attendance saved.'); res.redirect(`/admin/attendance?section=${section_id}&date=${date}`); });

// Gradebook
app.get('/admin/gradebook', T, (req, res) => res.render('admin/gradebook', { title: 'Gradebook', items: db.prepare(`SELECT gi.*, c.code, (SELECT COUNT(*) FROM grades g WHERE g.grade_item_id=gi.id AND g.points IS NOT NULL) graded, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id=gi.section_id) n FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id ORDER BY gi.due_date`).all() }));
app.get('/admin/gradebook/:id', T, (req, res) => { const item = db.prepare(`SELECT gi.*, c.code, c.title course FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE gi.id=?`).get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not found', msg: 'No such grade item.' });
  res.render('admin/gradeitem', { title: item.title, item, rows: db.prepare(`SELECT s.id, s.name, g.points, g.comment FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN grades g ON g.grade_item_id=? AND g.student_id=s.id WHERE e.section_id=? ORDER BY s.name`).all(item.id, item.section_id) }); });
const setGrade = (item, student, points, comment, source) => db.prepare(`INSERT INTO grades (grade_item_id, student_id, points, comment, source) VALUES (?,?,?,?,?) ON CONFLICT(grade_item_id, student_id) DO UPDATE SET points=excluded.points, comment=COALESCE(excluded.comment, comment), source=excluded.source, updated_at=CURRENT_TIMESTAMP`).run(item, student, points, comment || null, source);
app.post('/admin/gradebook/:id', T, (req, res) => { for (const [k, v] of Object.entries(req.body)) if (k.startsWith('p_') && v !== '') setGrade(req.params.id, Number(k.slice(2)), Number(v), null, 'manual');
  audit(req, 'grades.save', { item: req.params.id }); flash(req, 'Grades saved.'); res.redirect('/admin/gradebook/' + req.params.id); });

// Homework review
const subQ = `SELECT sb.*, s.name student, s.preferred_language, a.title_az, a.instructions_az, a.grade_item_id, c.code, cr.draft_az, cr.final_az, cr.is_sample, cr.drafted_by, cr.points cpoints, cr.approved_at FROM submissions sb JOIN students s ON s.id=sb.student_id JOIN assignments a ON a.id=sb.assignment_id JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN corrections cr ON cr.submission_id=sb.id`;
app.get('/admin/homework', T, (req, res) => res.render('admin/homework', { title: 'Homework review', subs: db.prepare(subQ + ` ORDER BY sb.status='returned', sb.submitted_at DESC`).all() }));
app.get('/admin/homework/:id', T, (req, res) => { const sb = db.prepare(subQ + ' WHERE sb.id=?').get(req.params.id); if (!sb) return res.status(404).render('error', { title: 'Not found', msg: 'No such submission.' }); res.render('admin/review', { title: 'Review', sb }); });
app.post('/admin/homework/:id/draft', T, async (req, res) => { const sb = db.prepare(subQ + ' WHERE sb.id=?').get(req.params.id); if (!sb) return res.sendStatus(404);
  const d = await draftCorrection(sb.body, sb.student);
  db.prepare(`INSERT INTO corrections (submission_id, draft_az, is_sample, drafted_by) VALUES (?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET draft_az=excluded.draft_az, is_sample=excluded.is_sample, drafted_by=excluded.drafted_by, updated_at=CURRENT_TIMESTAMP`).run(sb.id, d.text, d.isSample ? 1 : 0, d.by);
  db.prepare(`UPDATE submissions SET status='draft_ready' WHERE id=? AND status='submitted'`).run(sb.id); flash(req, d.isSample ? 'Sample Azeri draft created (no AI key set). Edit before approving.' : 'AI Azeri draft created. Review before approving.'); res.redirect('/admin/homework/' + sb.id); });
app.post('/admin/homework/:id/approve', T, (req, res) => { const sb = db.prepare(subQ + ' WHERE sb.id=?').get(req.params.id); if (!sb) return res.sendStatus(404);
  const text = String(req.body.final_az || '').trim(); if (!text) { flash(req, 'Write the feedback first.'); return res.redirect('/admin/homework/' + sb.id); }
  const pts = req.body.points === '' || req.body.points == null ? null : Number(req.body.points);
  db.prepare(`INSERT INTO corrections (submission_id, final_az, points, approved_by, approved_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(submission_id) DO UPDATE SET final_az=excluded.final_az, points=excluded.points, approved_by=excluded.approved_by, approved_at=CURRENT_TIMESTAMP`).run(sb.id, text, pts, req.session.user.id);
  db.prepare(`UPDATE submissions SET status='returned' WHERE id=?`).run(sb.id);
  if (pts != null && sb.grade_item_id) setGrade(sb.grade_item_id, sb.student_id, pts, 'Ev tapşırığı', 'homework');
  audit(req, 'homework.approve', { id: sb.id }); flash(req, 'Feedback approved and returned to the student.'); res.redirect('/admin/homework'); });

// WhatsApp inbox
app.get('/admin/whatsapp', A, (req, res) => { const status = ['pending', 'applied', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const msgs = db.prepare(`SELECT m.*, s.name student FROM whatsapp_messages m LEFT JOIN students s ON s.id=m.student_id ${status === 'all' ? '' : 'WHERE m.status=?'} ORDER BY m.received_at DESC`).all(...(status === 'all' ? [] : [status])).map(m => ({ ...m, payload: JSON.parse(m.suggested_payload || '{}') }));
  res.render('admin/whatsapp', { title: 'WhatsApp inbox', msgs, status, students: db.prepare(`SELECT id, name FROM students ORDER BY name`).all(), sections: sectionsList(),
    items: db.prepare(`SELECT gi.id, gi.title, c.code FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id`).all(),
    assignments: db.prepare(`SELECT a.id, a.title_az, c.code FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id`).all(), verifySet: !!VERIFY_TOKEN }); });
app.post('/admin/whatsapp/test', A, (req, res) => { wa.ingest({ from: req.body.from, name: req.body.name, text: req.body.text }, { demo: true }); flash(req, 'Test message added to the inbox.'); res.redirect('/admin/whatsapp'); });
app.post('/admin/whatsapp/:id/dismiss', A, (req, res) => { db.prepare(`UPDATE whatsapp_messages SET status='dismissed', handled_by=?, handled_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.session.user.id, req.params.id); flash(req, 'Dismissed.'); res.redirect('/admin/whatsapp'); });
app.post('/admin/whatsapp/:id/apply', A, (req, res) => {
  const m = db.prepare('SELECT * FROM whatsapp_messages WHERE id=?').get(req.params.id); if (!m || m.status !== 'pending') { flash(req, 'Message already handled.'); return res.redirect('/admin/whatsapp'); }
  const b = req.body; const action = b.action; let note;
  try {
    db.transaction(() => {
      if (action === 'create_student') { if (!b.name?.trim()) throw new Error('Name is required');
        const r = db.prepare(`INSERT INTO students (name, preferred_language, whatsapp_phone, email, status, notes) VALUES (?,?,?,?, 'applicant', ?)`).run(b.name.trim(), b.preferred_language || 'az', b.whatsapp_phone || m.from_number, b.email || null, 'From WhatsApp: ' + (m.body || '').slice(0, 300));
        db.prepare('UPDATE whatsapp_messages SET student_id=? WHERE id=?').run(r.lastInsertRowid, m.id); note = 'Applicant created.'; }
      else if (action === 'mark_attendance') { if (!b.student_id || !b.section_id || !ST.includes(b.status)) throw new Error('Pick student, class and status'); markAtt(b.section_id, b.date, b.student_id, b.status, m.body?.slice(0, 200), 'whatsapp'); note = 'Attendance recorded.'; }
      else if (action === 'record_grade') { if (!b.student_id || !b.grade_item_id || b.points === '') throw new Error('Pick student, item and points'); setGrade(b.grade_item_id, b.student_id, Number(b.points), 'via WhatsApp', 'whatsapp'); note = 'Grade recorded.'; }
      else if (action === 'file_homework') { if (!b.student_id || !b.assignment_id) throw new Error('Pick student and assignment');
        db.prepare(`INSERT INTO submissions (assignment_id, student_id, body, source) VALUES (?,?,?, 'whatsapp') ON CONFLICT(assignment_id, student_id) DO UPDATE SET body=excluded.body, status='submitted', submitted_at=CURRENT_TIMESTAMP`).run(b.assignment_id, b.student_id, m.body); note = 'Homework filed for review.'; }
      else throw new Error('Choose an action');
      if (b.student_id && !m.student_id) db.prepare('UPDATE whatsapp_messages SET student_id=? WHERE id=?').run(b.student_id, m.id);
      db.prepare(`UPDATE whatsapp_messages SET status='applied', suggested_action=?, handled_by=?, handled_at=CURRENT_TIMESTAMP WHERE id=?`).run(action, req.session.user.id, m.id);
    })();
    audit(req, 'whatsapp.apply', { id: m.id, action }); flash(req, note);
  } catch (e) { flash(req, 'Not applied: ' + e.message); }
  res.redirect('/admin/whatsapp');
});

// Bots + report
app.get('/admin/bots', A, (req, res) => res.render('admin/bots', { title: 'Helper bots', bots: bots.BOTS, r: bots.weeklyReport(), herald: process.env.HERALD_HOURS || 48 }));
app.get('/admin/report', A, (req, res) => res.render('admin/report', { title: 'Weekly report', r: bots.weeklyReport(), bots: bots.BOTS }));
app.get('/admin/report.json', A, (req, res) => res.json(bots.weeklyReport()));

// Student portal (Azerbaijani)
const S = need('student');
const me = req => db.prepare('SELECT * FROM students WHERE user_id=?').get(req.session.user.id);
app.get('/telebe', S, (req, res) => { const s = me(req); if (!s) return res.render('error', { title: 'Xəta', msg: 'Tələbə profili tapılmadı.' });
  res.render('student/home', { title: 'Tələbə kabineti', s, lang: 'az',
    classes: db.prepare(`SELECT c.code, c.title_az, sec.schedule, sec.room, t.name teacher FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id WHERE e.student_id=?`).all(s.id),
    att: db.prepare(`SELECT a.status, COUNT(*) n FROM attendance a WHERE a.student_id=? GROUP BY a.status`).all(s.id),
    grades: db.prepare(`SELECT gi.title, gi.max_points, g.points, c.code FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE g.student_id=?`).all(s.id),
    hw: db.prepare(`SELECT a.*, c.code, sb.id sub_id, sb.status sub_status, sb.body, cr.final_az, cr.points FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=sec.id AND e.student_id=? LEFT JOIN submissions sb ON sb.assignment_id=a.id AND sb.student_id=? LEFT JOIN corrections cr ON cr.submission_id=sb.id AND sb.status='returned' ORDER BY a.due_date`).all(s.id, s.id) }); });
app.post('/telebe/tapsiriq/:id', S, (req, res) => { const s = me(req); const body = String(req.body.body || '').trim();
  const ok = db.prepare(`SELECT 1 FROM assignments a JOIN enrollments e ON e.section_id=a.section_id AND e.student_id=? WHERE a.id=?`).get(s?.id, req.params.id);
  if (!ok || !body) { flash(req, 'Mətn boşdur və ya tapşırıq tapılmadı.'); return res.redirect('/telebe'); }
  db.prepare(`INSERT INTO submissions (assignment_id, student_id, body) VALUES (?,?,?) ON CONFLICT(assignment_id, student_id) DO UPDATE SET body=excluded.body, status='submitted', submitted_at=CURRENT_TIMESTAMP`).run(req.params.id, s.id, body);
  flash(req, 'Tapşırıq göndərildi! Müəllim yoxlayandan sonra rəyi burada görəcəksiniz.'); res.redirect('/telebe'); });

app.use((req, res) => res.status(404).render('error', { title: 'Not found', msg: 'Page not found.' }));
app.use((err, req, res, _n) => { console.error(err); res.status(500).render('error', { title: 'Error', msg: 'Something went wrong.' }); });
if (require.main === module) app.listen(PORT, () => console.log(`Baku Bible Institute on http://localhost:${PORT} (demo=${DEMO})`));
module.exports = app;
