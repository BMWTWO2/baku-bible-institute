const path = require('path'); const crypto = require('crypto');
const express = require('express'); const session = require('express-session'); const bcrypt = require('bcryptjs');
const db = require('./db'); const wa = require('./whatsapp'); const bots = require('./bots'); const { draftCorrection } = require('./azeri'); const notes = require('./notes');
const hw = require('./homework'); const outbox = require('./outbox'); const grades = require('./grades'); const late = require('./late'); const persist = require('./persist');

const app = express(); const PORT = Number(process.env.PORT || 3050);
const DEMO = process.env.DEMO_MODE != null ? process.env.DEMO_MODE !== 'false' : process.env.NODE_ENV !== 'production';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views')); app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'" }); next(); });
// Durable mode: after any write request, save a snapshot of the whole DB (debounced). See src/persist.js.
app.use((req, res, next) => { if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', () => { if (res.statusCode < 400) persist.schedule(req.method + ' ' + req.path.split('/').slice(0, 3).join('/')); }); next(); });
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

// Homework assistant API (token-protected JSON, no session/CSRF). See docs/HOMEWORK_API.md.
const API_TOKEN = () => process.env.HOMEWORK_API_TOKEN || '';
const apiAuth = (req, res, next) => {
  const t = API_TOKEN(); if (t.length < 16) return res.status(503).json({ error: 'HOMEWORK_API_TOKEN is not configured on the server.' });
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (got.length !== t.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t))) return res.status(401).json({ error: 'unauthorized' });
  next(); };
const apiItem = s => ({ id: s.id, status: s.status, course_code: s.course_code, title: s.title, assignment_id: s.assignment_id, due_baku: s.due_at ? late.fmtBaku(s.due_at) : null, minutes_late: s.minutes_late, deduction_pct: s.deduction_pct, max_points: s.max_points, raw_score: s.raw_score, final_score: s.final_score, student_first_name: String(s.student_name || '').split(' ')[0], lang: s.lang, body: s.body,
  translation_en: s.translation_en, draft_en: s.draft_en, final_en: s.final_en, approved_at: s.approved_at, submitted_at: s.submitted_at });
const api = express.Router(); api.use(express.json({ limit: '200kb' }), apiAuth);
api.get('/status', (req, res) => res.json({ counts: hw.counts(), builtInAi: hw.llmEnabled(), durable: persist.status().durable }));
api.get('/needs-draft', (req, res) => res.json({ items: hw.byStatus('submitted').map(apiItem) }));
api.post('/:id/draft', (req, res) => { const s = hw.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const draft = String(req.body?.draft_en || '').trim(); const tr = String(req.body?.translation_en || '').trim();
  if (!draft) return res.status(400).json({ error: 'draft_en is required' });
  if (s.lang === 'az' && !tr) return res.status(400).json({ error: 'translation_en is required for Azeri submissions' });
  if (!hw.setDraft(s.id, { translation_en: tr || null, draft_en: draft, by: String(req.body?.by || 'assistant').slice(0, 60) })) return res.status(409).json({ error: 'already approved by Bruce or returned; draft not changed', status: s.status });
  res.json({ ok: true, id: s.id, status: 'drafted' }); });
api.get('/needs-azeri', (req, res) => res.json({ items: hw.byStatus('approved_by_bruce').map(apiItem) }));
api.post('/:id/return', (req, res) => { const s = hw.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const az = String(req.body?.return_az || '').trim(); if (!az) return res.status(400).json({ error: 'return_az is required' });
  if (s.status !== 'approved_by_bruce') return res.status(409).json({ error: 'refused: Bruce has not approved this correction', status: s.status });
  if (!hw.setReturn(s.id, az, String(req.body?.by || 'assistant').slice(0, 60))) return res.status(409).json({ error: 'refused', status: hw.get(s.id)?.status });
  res.json({ ok: true, id: s.id, status: 'returned' }); });
app.use('/api/homework', api);

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
app.get('/healthz', (_q, res) => res.json({ ok: true, app: 'baku-bible-institute', db: db.prepare('SELECT 1 ok').get().ok === 1, demo: DEMO, durable: persist.status().durable }));
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
  res.render('admin/student', { title: s.name, s, sections: sectionsList(), avgs: grades.averages(s.id),
    enr: db.prepare(`SELECT e.*, c.code, c.title, sec.id section_id FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=?`).all(s.id),
    att: db.prepare(`SELECT a.*, cs.session_date, c.code FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN sections sec ON sec.id=cs.section_id JOIN courses c ON c.id=sec.course_id WHERE a.student_id=? ORDER BY cs.session_date DESC`).all(s.id),
    grades: db.prepare(`SELECT g.*, gi.title, gi.max_points, gi.weight, c.code FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE g.student_id=?`).all(s.id),
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
app.get('/admin/gradebook', T, (req, res) => res.render('admin/gradebook', { title: 'Gradebook', sections: sectionsList(), items: db.prepare(`SELECT gi.*, c.code, sec.id sid, (SELECT a.id FROM assignments a WHERE a.grade_item_id=gi.id) assignment_id, (SELECT COUNT(*) FROM grades g WHERE g.grade_item_id=gi.id AND g.points IS NOT NULL) graded, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id=gi.section_id) n FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id ORDER BY gi.due_date`).all() }));
app.get('/admin/gradebook/:id', T, (req, res) => { const item = db.prepare(`SELECT gi.*, c.code, c.title course FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE gi.id=?`).get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not found', msg: 'No such grade item.' });
  res.render('admin/gradeitem', { title: item.title, item, rows: db.prepare(`SELECT s.id, s.name, g.points, g.comment FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN grades g ON g.grade_item_id=? AND g.student_id=s.id WHERE e.section_id=? ORDER BY s.name`).all(item.id, item.section_id) }); });
const setGrade = (item, student, points, comment, source) => db.prepare(`INSERT INTO grades (grade_item_id, student_id, points, comment, source) VALUES (?,?,?,?,?) ON CONFLICT(grade_item_id, student_id) DO UPDATE SET points=excluded.points, comment=COALESCE(excluded.comment, comment), source=excluded.source, updated_at=CURRENT_TIMESTAMP`).run(item, student, points, comment || null, source);
// Graded items that are not homework (exams, quizzes, participation…). Homework items come from /admin/assignments.
app.post('/admin/gradebook', T, (req, res) => { const b = req.body; const sec = db.prepare('SELECT id FROM sections WHERE id=?').get(b.section_id);
  const max = Number(b.max_points), w = b.weight === '' || b.weight == null ? 1 : Number(b.weight);
  if (!sec || !String(b.title || '').trim() || !(max > 0) || !(w >= 0)) { flash(req, 'Not saved: pick a class, a title, max points > 0 and weight ≥ 0.'); return res.redirect('/admin/gradebook'); }
  const id = db.prepare('INSERT INTO grade_items (section_id, title, max_points, due_date, weight) VALUES (?,?,?,?,?)').run(sec.id, String(b.title).trim(), max, b.due_date || null, w).lastInsertRowid;
  audit(req, 'gradeitem.create', { id }); flash(req, 'Graded item added.'); res.redirect('/admin/gradebook/' + id); });
app.post('/admin/gradebook/:id/edit', T, (req, res) => { const b = req.body; const max = Number(b.max_points), w = Number(b.weight);
  if (!String(b.title || '').trim() || !(max > 0) || !(w >= 0)) { flash(req, 'Not saved: title, max points > 0 and weight ≥ 0 are required.'); return res.redirect('/admin/gradebook/' + req.params.id); }
  db.prepare('UPDATE grade_items SET title=?, max_points=?, weight=?, due_date=? WHERE id=?').run(String(b.title).trim(), max, w, b.due_date || null, req.params.id);
  db.prepare('UPDATE assignments SET max_points=? WHERE grade_item_id=?').run(max, req.params.id);
  audit(req, 'gradeitem.update', { id: req.params.id }); flash(req, 'Item updated.'); res.redirect('/admin/gradebook/' + req.params.id); });
app.post('/admin/gradebook/:id/delete', A, (req, res) => { if (req.body.confirm !== 'yes') { flash(req, 'Tick the confirmation box to delete this item and its grades.'); return res.redirect('/admin/gradebook/' + req.params.id); }
  db.transaction(() => { db.prepare('DELETE FROM assignments WHERE grade_item_id=?').run(req.params.id); db.prepare('DELETE FROM grade_items WHERE id=?').run(req.params.id); })();
  audit(req, 'gradeitem.delete', { id: req.params.id }); flash(req, 'Item deleted.'); res.redirect('/admin/gradebook'); });
app.get('/admin/gradebook/class/:sid', T, (req, res) => { const sec = sectionsList().find(x => x.id === Number(req.params.sid)); if (!sec) return res.status(404).render('error', { title: 'Not found', msg: 'No such class.' });
  res.render('admin/classgrades', { title: sec.code + ' grades', sec, rows: grades.sectionAverages(sec.id), items: db.prepare('SELECT * FROM grade_items WHERE section_id=? ORDER BY due_date, id').all(sec.id) }); });
app.post('/admin/enrollments/:id/final', A, (req, res) => { const v = String(req.body.final_grade || '').trim().slice(0, 20) || null;
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(req.params.id); if (!e) return res.sendStatus(404);
  db.prepare('UPDATE enrollments SET final_grade=? WHERE id=?').run(v, e.id); audit(req, 'enrollment.final_grade', { id: e.id });
  flash(req, 'Final grade saved.'); const back = String(req.body.back || ''); res.redirect(back.startsWith('/admin/') ? back : '/admin/students/' + e.student_id); });
app.post('/admin/gradebook/:id', T, (req, res) => { for (const [k, v] of Object.entries(req.body)) if (k.startsWith('p_') && v !== '') setGrade(req.params.id, Number(k.slice(2)), Number(v), null, 'manual');
  for (const [k, v] of Object.entries(req.body)) if (k.startsWith('c_')) { const c = String(v).trim().slice(0, 2000) || null; const sid = Number(k.slice(2));
    if (c) db.prepare(`INSERT INTO grades (grade_item_id, student_id, comment, source) VALUES (?,?,?, 'manual') ON CONFLICT(grade_item_id, student_id) DO UPDATE SET comment=excluded.comment, updated_at=CURRENT_TIMESTAMP`).run(req.params.id, sid, c);
    else db.prepare('UPDATE grades SET comment=NULL WHERE grade_item_id=? AND student_id=?').run(req.params.id, sid); }
  audit(req, 'grades.save', { item: req.params.id }); flash(req, 'Grades saved.'); res.redirect('/admin/gradebook/' + req.params.id); });

// Homework review
const subQ = `SELECT sb.*, s.name student, s.preferred_language, a.title_az, a.instructions_az, a.grade_item_id, c.code, cr.draft_az, cr.final_az, cr.is_sample, cr.drafted_by, cr.points cpoints, cr.approved_at FROM submissions sb JOIN students s ON s.id=sb.student_id JOIN assignments a ON a.id=sb.assignment_id JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN corrections cr ON cr.submission_id=sb.id`;
app.get('/admin/homework', T, (req, res) => res.render('admin/homework', { title: 'Homework review', anytime: hw.all(), builtInAi: hw.llmEnabled(), subs: db.prepare(subQ + ` ORDER BY sb.status='returned', sb.submitted_at DESC`).all() }));
// Anytime homework: Bruce edits + approves the English correction; only then is it translated to Azeri and returned.
const hwOr404 = (req, res) => { const s = hw.get(req.params.id); if (!s) res.status(404).render('error', { title: 'Not found', msg: 'No such submission.' }); return s; };
app.get('/admin/homework/anytime/:id', T, (req, res) => { const s = hwOr404(req, res); if (!s) return; res.render('admin/anytime', { title: 'Homework · ' + s.title, s, late, builtInAi: hw.llmEnabled() }); });

// Assignments: due date + time (Baku), max points, late policy. Creating one also creates its gradebook item.
const assignQ = `SELECT a.*, c.code, c.title course, gi.max_points gi_max, (SELECT COUNT(*) FROM hw_submissions h WHERE h.assignment_id=a.id) nsub FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN grade_items gi ON gi.id=a.grade_item_id`;
app.get('/admin/assignments', T, (req, res) => res.render('admin/assignments', { title: 'Assignments', late, sections: sectionsList(), list: db.prepare(assignQ + ' ORDER BY a.due_at IS NULL, a.due_at DESC, a.id DESC').all() }));
const readAssign = b => { const title = String(b.title_az || '').trim(); const due = late.bakuToUtcIso(b.due_date, b.due_time); const max = Number(b.max_points);
  if (!title) throw new Error('Title is required.'); if (!due) throw new Error('Due date and time are required (Baku time).');
  if (!isFinite(max) || max <= 0) throw new Error('Max points must be a positive number.');
  return { title, instructions: String(b.instructions_az || '').trim() || null, due, dueDate: b.due_date, max, policy: late.normalizePolicy(String(b.late_policy || '').trim() || late.DEFAULT_POLICY) }; };
app.post('/admin/assignments', T, (req, res) => { try { const v = readAssign(req.body); const sec = db.prepare('SELECT id FROM sections WHERE id=?').get(req.body.section_id); if (!sec) throw new Error('Pick a class.');
    db.transaction(() => { const gi = db.prepare('INSERT INTO grade_items (section_id, title, max_points, due_date) VALUES (?,?,?,?)').run(sec.id, v.title, v.max, v.dueDate).lastInsertRowid;
      const aid = db.prepare('INSERT INTO assignments (section_id, grade_item_id, title_az, instructions_az, due_date, due_at, max_points, late_policy) VALUES (?,?,?,?,?,?,?,?)').run(sec.id, gi, v.title, v.instructions, v.dueDate, v.due, v.max, v.policy).lastInsertRowid;
      // Queue (never send) an Azeri notice to every enrolled student; Bruce approves on /admin/outbox.
      const code = db.prepare('SELECT c.code FROM sections s JOIN courses c ON c.id=s.course_id WHERE s.id=?').get(sec.id).code; let n = 0;
      for (const st of db.prepare(`SELECT s.name, COALESCE(s.email, u.email) email FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN users u ON u.id=s.user_id WHERE e.section_id=? AND s.status='active'`).all(sec.id)) {
        const t = outbox.tplAssignment({ name: st.name, code, title: v.title, due: late.fmtBaku(v.due), instructions: v.instructions }); if (outbox.queue({ to: st.email, name: st.name, subject: t.subject, text: t.text, kind: 'assignment_notice', ref: 'assignment:' + aid })) n++; }
      req._queued = n; })();
    audit(req, 'assignment.create', { title: v.title }); flash(req, `Assignment created and shown to every student in the class. ${req._queued || 0} Azeri email notice(s) are waiting in the Outbox for your approval — nothing has been sent.`);
  } catch (e) { flash(req, 'Not saved: ' + e.message); } res.redirect('/admin/assignments'); });
app.post('/admin/assignments/:id/delete', A, (req, res) => { const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id); if (!a) return res.sendStatus(404);
  if (req.body.confirm !== 'yes') { flash(req, 'Tick the confirmation box to delete the assignment.'); return res.redirect('/admin/assignments'); }
  db.transaction(() => { db.prepare(`DELETE FROM email_outbox WHERE ref=? AND status='pending'`).run('assignment:' + a.id); db.prepare('DELETE FROM assignments WHERE id=?').run(a.id); if (a.grade_item_id) db.prepare('DELETE FROM grade_items WHERE id=?').run(a.grade_item_id); })();
  audit(req, 'assignment.delete', { id: a.id }); flash(req, 'Assignment deleted (its submissions are kept).'); res.redirect('/admin/assignments'); });
app.post('/admin/assignments/:id', T, (req, res) => { const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id); if (!a) return res.sendStatus(404);
  try { const v = readAssign(req.body);
    db.transaction(() => { db.prepare('UPDATE assignments SET title_az=?, instructions_az=?, due_date=?, due_at=?, max_points=?, late_policy=? WHERE id=?').run(v.title, v.instructions, v.dueDate, v.due, v.max, v.policy, a.id);
      if (a.grade_item_id) db.prepare('UPDATE grade_items SET title=?, max_points=?, due_date=? WHERE id=?').run(v.title, v.max, v.dueDate, a.grade_item_id);
      // Re-time submissions that Bruce has not approved yet.
      for (const h of db.prepare(`SELECT id, submitted_at FROM hw_submissions WHERE assignment_id=? AND status IN ('submitted','drafted')`).all(a.id)) { const m = late.minutesLate(v.due, h.submitted_at);
        db.prepare('UPDATE hw_submissions SET due_at=?, max_points=?, late_policy=?, minutes_late=?, deduction_pct=? WHERE id=?').run(v.due, v.max, v.policy, m, late.deductionPct(m, v.policy), h.id); } })();
    audit(req, 'assignment.update', { id: a.id }); flash(req, 'Assignment updated.');
  } catch (e) { flash(req, 'Not saved: ' + e.message); } res.redirect('/admin/assignments'); });
app.post('/admin/homework/anytime/:id/save', T, (req, res) => { const s = hwOr404(req, res); if (!s) return;
  if (!hw.saveEdit(s.id, String(req.body.final_en || '').trim() || null)) flash(req, 'This homework was already returned; it can no longer be edited.'); else flash(req, 'Edits saved. Nothing has been sent to the student.');
  res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/approve', T, async (req, res) => { const s = hwOr404(req, res); if (!s) return;
  const text = String(req.body.final_en || '').trim();
  if (!text) { flash(req, 'Write or edit the English correction first.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  const num = v => (v == null || String(v).trim() === '') ? null : Number(v);
  const raw = num(req.body.raw_score), ovr = num(req.body.final_override);
  if ([raw, ovr].some(v => v != null && (!isFinite(v) || v < 0 || (s.max_points != null && v > s.max_points)))) { hw.saveEdit(s.id, text); flash(req, `Scores must be numbers from 0 to ${s.max_points ?? 'the max'}.`); return res.redirect('/admin/homework/anytime/' + s.id); }
  if (s.max_points != null && raw == null && ovr == null) { hw.saveEdit(s.id, text); flash(req, 'Enter the score (points) before approving.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  if (req.body.reviewed !== 'yes') { hw.saveEdit(s.id, text); flash(req, 'Edits saved. Tick “I have reviewed and edited this correction” to approve.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  if (!hw.approve(s.id, text, req.session.user.name, hw.scoreFor(s, raw, ovr))) { flash(req, 'Already returned to the student.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  audit(req, 'homework.anytime.approve', { id: s.id });
  const done = await hw.autoReturn(s.id);
  flash(req, done ? 'Approved. The Azeri version was created and returned to the student.' : 'Approved. Your English correction is queued for Azeri translation; the student will see it once it is translated.');
  res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/unapprove', T, (req, res) => { const s = hwOr404(req, res); if (!s) return;
  flash(req, hw.unapprove(s.id) ? 'Approval withdrawn. Nothing will be translated or returned until you approve again.' : 'Cannot withdraw: it was already returned.');
  audit(req, 'homework.anytime.unapprove', { id: s.id }); res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/delete', A, (req, res) => { const s = hwOr404(req, res); if (!s) return; hw.remove(s.id); audit(req, 'homework.anytime.delete', { id: s.id }); flash(req, 'Submission deleted.'); res.redirect('/admin/homework'); });
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

// Email outbox: nothing is sent unless Bruce clicks Send here (and EMAIL_SENDING_ENABLED=true).
app.get('/admin/outbox', A, (req, res) => { const status = ['pending', 'sent', 'failed', 'discarded', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.render('admin/outbox', { title: 'Email outbox', status, msgs: outbox.list(status), counts: outbox.counts(), cfg: outbox.cfg(), check: req.session.mailCheck || null }); delete req.session.mailCheck; });
app.post('/admin/outbox/verify', A, async (req, res) => { req.session.mailCheck = await outbox.verify(); res.redirect('/admin/outbox'); });
app.post('/admin/outbox/:id/send', A, async (req, res) => { const r = await outbox.send(Number(req.params.id), req.session.user.name); audit(req, 'outbox.send', { id: req.params.id, ok: r.ok });
  flash(req, r.ok ? 'Email sent.' : 'Not sent: ' + r.error); res.redirect('/admin/outbox'); });
app.post('/admin/outbox/send-all', A, async (req, res) => { if (req.body.confirm !== 'yes') { flash(req, 'Tick the confirmation box to send all pending emails.'); return res.redirect('/admin/outbox'); }
  let ok = 0, bad = 0; let last = ''; for (const m of outbox.list('pending')) { const r = await outbox.send(m.id, req.session.user.name); if (r.ok) ok++; else { bad++; last = r.error; } }
  audit(req, 'outbox.send_all', { ok, bad }); flash(req, `Sent ${ok}. ${bad ? `Not sent: ${bad} (${last})` : ''}`); res.redirect('/admin/outbox'); });
app.post('/admin/outbox/:id/edit', A, (req, res) => { outbox.edit(Number(req.params.id), String(req.body.subject || '').slice(0, 200), String(req.body.body_text || '')); flash(req, 'Email updated (still waiting for your approval).'); res.redirect('/admin/outbox'); });
app.post('/admin/outbox/:id/delete', A, (req, res) => { const m = outbox.list('discarded').find(x => x.id === Number(req.params.id)); if (m) outbox.remove(m.id); flash(req, m ? 'Discarded email removed.' : 'Only discarded emails can be removed.'); res.redirect('/admin/outbox?status=discarded'); });
app.post('/admin/outbox/:id/discard', A, (req, res) => { outbox.discard(Number(req.params.id)); audit(req, 'outbox.discard', { id: req.params.id }); flash(req, 'Email discarded.'); res.redirect('/admin/outbox'); });

// Change my password (staff)
app.get('/admin/password', T, (req, res) => res.render('admin/password', { title: 'Change password' }));
app.post('/admin/password', T, (req, res) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id); const n = String(req.body.new_password || '');
  if (!u || !bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) { flash(req, 'Current password is incorrect.'); return res.redirect('/admin/password'); }
  if (n.length < 12 || n !== String(req.body.confirm_password || '')) { flash(req, 'New password must be at least 12 characters and match the confirmation.'); return res.redirect('/admin/password'); }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(n, 10), u.id); audit(req, 'password.change', {}); flash(req, 'Password changed.'); res.redirect('/admin/password'); });

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
    avgs: grades.averages(s.id),
    grades: db.prepare(`SELECT gi.title, gi.max_points, gi.weight, g.points, g.comment, c.code FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE g.student_id=?`).all(s.id),
    mine: hw.forStudent(req.session.user.email),
    courses: (() => { const mineC = db.prepare(`SELECT c.code, c.title_az, c.title FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=? ORDER BY c.code`).all(s.id);
      return mineC.length ? mineC : db.prepare('SELECT code, title_az, title FROM courses ORDER BY code').all(); })(),
    late, nowIso: new Date().toISOString(),
    hw: db.prepare(`SELECT a.*, c.code, (SELECT COUNT(*) FROM hw_submissions h WHERE h.assignment_id=a.id AND h.student_email=?) nmine FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=sec.id AND e.student_id=? ORDER BY COALESCE(a.due_at, a.due_date)`).all(String(req.session.user.email).toLowerCase(), s.id) }); });
// Submit for a specific assignment. Never blocked by the due date; late work gets the assignment's deduction.
app.post('/telebe/tapsiriq/:id', S, (req, res) => { const s = me(req); const body = String(req.body.body || '').trim();
  const a = db.prepare(`SELECT a.*, c.code FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=a.section_id AND e.student_id=? WHERE a.id=?`).get(s?.id, req.params.id);
  if (!a || !body) { flash(req, 'Mətn boşdur və ya tapşırıq tapılmadı.'); return res.redirect('/telebe#tapsiriqlarim'); }
  if (body.length > 20000) { flash(req, 'Mətn çox uzundur (ən çox 20 000 simvol).'); return res.redirect('/telebe#tapsiriqlarim'); }
  const id = hw.create({ student: s, email: req.session.user.email, course_code: a.code, title: a.title_az, body, assignment: a }); const h = hw.get(id);
  flash(req, 'Təşəkkür edirik! Tapşırığınız göndərildi.' + (h.minutes_late ? ` Son tarixdən sonra göndərildi (${late.lateText(h.minutes_late, 'az').toLowerCase()}), buna görə balınızdan ${h.deduction_pct}% çıxılacaq.` : '') + ' Müəllim yoxlayandan sonra rəyi burada görəcəksiniz.');
  res.redirect('/telebe#tapsiriqlarim'); hw.autoDraft(id).then(ok => ok && persist.schedule('autodraft')).catch(() => {}); });

// Anytime homework (no deadline): pick class, title, text.
app.post('/telebe/tapsiriq', S, async (req, res) => { const s = me(req); const b = req.body;
  const body = String(b.body || '').trim(); const title = String(b.title || '').trim().slice(0, 200); const code = String(b.course_code || '');
  const course = db.prepare('SELECT code FROM courses WHERE code=?').get(code);
  if (!s || !course || !title || !body) { flash(req, 'Zəhmət olmasa dərsi seçin, başlığı və mətni yazın.'); return res.redirect('/telebe#tapsiriqlarim'); }
  if (body.length > 20000) { flash(req, 'Mətn çox uzundur (ən çox 20 000 simvol).'); return res.redirect('/telebe#tapsiriqlarim'); }
  const id = hw.create({ student: s, email: req.session.user.email, course_code: course.code, title, body });
  flash(req, 'Təşəkkür edirik! Tapşırığınız göndərildi. Müəllim yoxlayandan sonra rəyi burada görəcəksiniz.');
  res.redirect('/telebe#tapsiriqlarim');
  hw.autoDraft(id).then(ok => ok && persist.schedule('autodraft')).catch(() => {}); });

// Class notes / Dərs xülasələri (content files, any signed-in user)
const N = need('student', 'teacher', 'admin');
app.get('/telebe/xulaseler', N, (req, res) => res.render('student/notes', { title: 'Dərs xülasələri', notes: notes.all(), lang: 'az' }));
app.get('/telebe/xulaseler/:slug', N, (req, res) => { const n = notes.get(req.params.slug);
  if (!n) return res.status(404).render('error', { title: 'Tapılmadı', msg: 'Bu xülasə tapılmadı.' });
  res.render('student/note', { title: n.title, n, lang: 'az' }); });

app.use((req, res) => res.status(404).render('error', { title: 'Not found', msg: 'Page not found.' }));
app.use((err, req, res, _n) => { console.error(err); res.status(500).render('error', { title: 'Error', msg: 'Something went wrong.' }); });
if (require.main === module) {
  if (persist.enabled()) {
    if (persist.isMarked()) { persist.attach(db); console.log('Durable mode on: changes are saved to Postgres.'); }
    else console.error('DATABASE_URL is set but this database was not restored by `npm run seed`; saving is OFF to protect the saved copy. Start with `npm run seed && npm start`.');
    const bye = () => { persist.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }
  app.listen(PORT, () => console.log(`Baku Bible Institute on http://localhost:${PORT} (demo=${DEMO})`));
}
module.exports = app;
