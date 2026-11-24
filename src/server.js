const path = require('path'); const crypto = require('crypto');
const express = require('express'); const bcrypt = require('bcryptjs');
const db = require('./db'); const wa = require('./whatsapp'); const bots = require('./bots'); const { draftCorrection } = require('./azeri'); const notes = require('./notes');
const hw = require('./homework'); const outbox = require('./outbox'); const grades = require('./grades'); const late = require('./late'); const persist = require('./persist'); const inbound = require('./inbound'); const sessions = require('./sessions'); const attqr = require('./attqr'); const lessons = require('./lessons');
const enroll = require('./enroll'); const pwreset = require('./pwreset');

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
  const { ids, homework } = wa.ingest(req.body);
  res.json({ ok: true, stored: ids.length, filed: (homework || []).length });
  for (const h of homework || []) {
    inbound.attachWhatsAppMedia(h.hwId, h.media).then(note => { if (note) persist.schedule('wa-media'); }).catch(() => {});
    hw.autoDraft(h.hwId).then(ok => ok && persist.schedule('autodraft')).catch(() => {});
  }
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
api.get('/needs-draft', (req, res) => { const qa = new Set(lessons.needsReview()); res.json({ items: hw.byStatus('submitted').filter(s => !qa.has(s.id)).map(apiItem) }); });
// ---- Lessons → five questions → per-answer review → overview (see docs/HOMEWORK_API.md "Assignment portal") ----
const BASE_URL = req => process.env.PUBLIC_URL || (process.env.NODE_ENV === 'production' ? 'https://bakubibleinstitute.org' : `${req.protocol}://${req.get('host')}`);
const lessonApi = l => { const a = l.assignment_id && lessons.assignment(l.assignment_id); const note = l.note_slug ? notes.get(l.note_slug) : null;
  const classNotes = notes.all().filter(n => !n.course || n.course === l.code).map(n => ({ slug: n.slug, title: n.title, course: n.course, body: n.body }));
  return { id: l.id, status: l.status, course_code: l.code, course: l.course, title: l.title, title_az: l.title_az, session_date: l.session_date, source: l.source, source_ref: l.source_ref, source_text: l.source_text,
    summary_en: l.summary_en, summary_az: l.summary_az, outline: l.outline, class_note: note ? { slug: note.slug, title: note.title, body: note.body } : null, class_notes: classNotes,
    assignment: a ? { id: a.id, published: !!a.published, max_points: a.max_points, choose_n: a.choose_n, questions: lessons.questions(a.id) } : null }; };
api.get('/lessons', (req, res) => res.json({ items: lessons.lessons(req.query.status || null).map(lessonApi) }));
api.get('/lessons/needs-summary', (req, res) => res.json({ items: lessons.lessons('needs_summary').map(lessonApi) }));
api.get('/lessons/needs-questions', (req, res) => res.json({ items: lessons.lessons('needs_questions').map(lessonApi) }));
api.get('/lessons/:id', (req, res) => { const l = lessons.lesson(req.params.id); if (!l) return res.status(404).json({ error: 'not found' }); res.json(lessonApi(l)); });
api.post('/lessons', (req, res) => { const b = req.body || {}; const sec = lessons.sectionByCode(b.course_code); if (!sec) return res.status(400).json({ error: 'course_code must be an existing class, e.g. "ECC 101"' });
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'title is required' });
  if (b.session_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.session_date)) return res.status(400).json({ error: 'session_date must be YYYY-MM-DD (Baku date)' });
  const r = lessons.createLesson({ section_id: sec.id, title: b.title, title_az: b.title_az, session_date: b.session_date, source: b.source || 'pocket', source_ref: b.source_ref, source_text: b.source_text, note_slug: b.note_slug, created_by: String(b.by || 'assistant').slice(0, 60) });
  if (!r.existed && b.summary_en) lessons.setSummary(r.id, { summary_en: b.summary_en, summary_az: b.summary_az, outline: b.outline, by: b.by });
  res.status(r.existed ? 200 : 201).json({ ok: true, id: r.id, existed: r.existed, status: lessons.lesson(r.id).status }); });
api.post('/lessons/:id/summary', (req, res) => { const b = req.body || {}; if (!String(b.summary_en || '').trim() || !String(b.outline || '').trim()) return res.status(400).json({ error: 'summary_en and outline are required (summary_az recommended)' });
  if (!lessons.setSummary(req.params.id, { summary_en: String(b.summary_en).trim(), summary_az: String(b.summary_az || '').trim(), outline: String(b.outline).trim(), title: b.title, title_az: b.title_az, by: String(b.by || 'assistant').slice(0, 60) })) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, id: Number(req.params.id), status: lessons.lesson(req.params.id).status }); });
api.post('/lessons/:id/questions', (req, res) => { const b = req.body || {}; const r = lessons.setQuestions(req.params.id, b.questions, { by: String(b.by || 'assistant').slice(0, 60), instructions_az: b.instructions_az });
  if (r.error) return res.status(r.code).json({ error: r.error });
  // Test hook: only the isolated TEST 000 class may be published by the API. Real classes are published by Bruce on the lesson page.
  if (b.publish_test) { const l = lessons.lesson(req.params.id); if (l.code !== 'TEST 000') return res.status(403).json({ error: 'publish_test is only allowed for the TEST 000 class' }); publishAssignment(r.assignment_id, { due: new Date(Date.now() + 7 * 864e5).toISOString(), max: lessons.MAX_POINTS }); }
  res.json({ ok: true, lesson_id: Number(req.params.id), assignment_id: r.assignment_id, published: !!lessons.assignment(r.assignment_id).published }); });
api.get('/needs-review', (req, res) => res.json({ items: lessons.needsReview().map(id => { const s = hw.get(id); const a = lessons.assignment(s.assignment_id); const l = a.lesson_id ? lessons.lesson(a.lesson_id) : null;
  return { ...apiItem(s), answers_split: lessons.answers(id).map(x => ({ question: x.question_n, text: x.answer_text })), split_by: db.prepare('SELECT split_by FROM hw_submissions WHERE id=?').get(id).split_by,
    choose_n: a.choose_n, points_per_question: (a.max_points || lessons.MAX_POINTS) / (a.choose_n || lessons.CHOOSE), questions: lessons.questions(a.id),
    lesson: l ? { id: l.id, title: l.title, session_date: l.session_date, summary_en: l.summary_en, outline: l.outline, class_note: l.note_slug ? (notes.get(l.note_slug) || {}).body || null : null } : null }; }) }));
api.post('/:id/review', (req, res) => { const r = lessons.review(Number(req.params.id), req.body || {}); if (r.error) return res.status(r.code).json({ error: r.error }); res.json(r); });
api.get('/needs-report', (req, res) => res.json({ items: lessons.needsReport().map(id => lessons.overview(id, BASE_URL(req))) }));
api.post('/:id/reported', (req, res) => { if (!lessons.markReported(Number(req.params.id))) return res.status(404).json({ error: 'not found or not reviewed' }); res.json({ ok: true }); });
api.get('/overview/:id', (req, res) => { const o = lessons.overview(Number(req.params.id), BASE_URL(req)); if (!o) return res.status(404).json({ error: 'not a five-question submission' }); res.json(o); });
api.get('/assignments/:id/overview', (req, res) => { const a = lessons.assignment(req.params.id); if (!lessons.isQA(a)) return res.status(404).json({ error: 'not a five-question assignment' });
  res.json({ assignment_id: a.id, course_code: a.code, title_az: a.title_az, published: !!a.published, questions: lessons.questions(a.id), submissions: lessons.submissionsFor(a.id).map(id => lessons.overview(id, BASE_URL(req))) }); });
api.get('/:id/draft', (req, res) => { const s = hw.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  let gradebook_points = null;
  if (s.assignment_id && s.student_id) { const a = db.prepare('SELECT grade_item_id FROM assignments WHERE id=?').get(s.assignment_id);
    if (a?.grade_item_id) { const g = db.prepare('SELECT points FROM grades WHERE grade_item_id=? AND student_id=?').get(a.grade_item_id, s.student_id); if (g && g.points != null) gradebook_points = g.points; } }
  res.json({ id: s.id, status: s.status, lang: s.lang, student_first_name: String(s.student_name || '').split(' ')[0],
    course_code: s.course_code, title: s.title, translation_en: s.translation_en || null, draft_en: s.draft_en || null,
    final_en: s.final_en || null, return_az: s.return_az || null, drafted_by: s.drafted_by || null, drafted_at: s.drafted_at || null,
    raw_score: s.raw_score ?? null, final_score: s.final_score ?? null, max_points: s.max_points ?? null, gradebook_points }); });
api.post('/:id/draft', (req, res) => { const s = hw.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const draft = String(req.body?.draft_en || '').trim(); const tr = String(req.body?.translation_en || '').trim();
  if (!draft) return res.status(400).json({ error: 'draft_en is required' });
  if (s.lang === 'az' && !tr) return res.status(400).json({ error: 'translation_en is required for Azeri submissions' });
  if (!hw.setDraft(s.id, { translation_en: tr || null, draft_en: draft, by: String(req.body?.by || 'assistant').slice(0, 60) })) return res.status(409).json({ error: 'already approved by Bruce or returned; draft not changed', status: s.status });
  const final = String(req.body?.final_en || '').trim();
  if (final) { const cur = hw.get(s.id); if (cur.status !== 'drafted') return res.status(409).json({ error: 'final_en not saved; not drafted', status: cur.status }); hw.saveEdit(s.id, final); }
  res.json({ ok: true, id: s.id, status: 'drafted', final_en_saved: !!final }); });
api.post('/:id/approve', (req, res) => {
  const b = req.body || {};
  const plan = hw.planApprove(Number(req.params.id), { score: b.score, override: b.final_override, reviewed: b.reviewed, by: b.by, onlyDrafted: true });
  if (!plan.ok) return res.status(plan.code).json({ error: plan.error, status: plan.status || null });
  if (b.dry_run) return res.json({ ok: true, dry_run: true, id: plan.id, would_write: { status: plan.status, raw_score: plan.raw_score, deduction_points: plan.deduction_points, final_score: plan.final_score, score_overridden: plan.score_overridden, approved_by: plan.approved_by, final_en_len: plan.final_en.length } });
  const r = hw.applyApprove(plan); if (!r.ok) return res.status(r.code).json({ error: r.error });
  res.json(r);
});
api.get('/needs-azeri', (req, res) => res.json({ items: hw.byStatus('approved_by_bruce').map(apiItem) }));
api.post('/:id/return', (req, res) => { const s = hw.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const az = String(req.body?.return_az || '').trim(); if (!az) return res.status(400).json({ error: 'return_az is required' });
  if (s.status !== 'approved_by_bruce') return res.status(409).json({ error: 'refused: Bruce has not approved this correction', status: s.status });
  if (!hw.setReturn(s.id, az, String(req.body?.by || 'assistant').slice(0, 60))) return res.status(409).json({ error: 'refused', status: hw.get(s.id)?.status });
  res.json({ ok: true, id: s.id, status: 'returned' }); });
app.use('/api/homework', api);
// Read-only helper-bot flags for the scheduled check. Same bearer token. No writes.
app.get('/api/flags', apiAuth, (_req, res) => res.json(bots.flagsPayload()));
// Read-only QR attendance status for helper bots / checks (same bearer token). Opening it also tops up the weekly code window.
app.get('/api/attendance', apiAuth, (req, res) => { if (attqr.ensureWindow()) persist.schedule('qr-codes'); const base = PUBLIC_URL() || `${req.protocol}://${req.get('host')}`;
  res.json({ term_start: attqr.termStart(), today_baku: attqr.bakuDate(), current_week: attqr.weekOf(), sessions: attqr.SESSIONS, points: attqr.POINTS,
    classes: attqr.sections().map(s => ({ section_id: s.id, code: s.code, title: s.title, weeks: attqr.window(s.id).map(c => { const r = attqr.roster(c);
      return { week: c.week_no, valid_from: c.valid_from, valid_until: c.valid_until, live: attqr.isLive(c), display: base + qrBase(s.id, c.week_no), scanned: r.scanned.map(x => x.name), missing: r.missing.map(x => x.name), marked: r.marked.map(x => ({ name: x.name, status: x.status })) }; }) })) }); });
app.get('/api/attendance/qr/:sid/week/:week.png', apiAuth, async (req, res) => { const c = attqr.getCode(Number(req.params.sid), Number(req.params.week)); if (!c) return res.status(404).json({ error: 'no such code' });
  res.set('Cache-Control', 'no-store').type('png').send(await attqr.png(scanUrl(req, c), req.query.size || 1200)); });


// Homepage enrollment requests (same bearer token as homework/flags). See docs/ENROLLMENTS.md.
app.get('/api/enrollments', apiAuth, (req, res) => {
  const unnotified = String(req.query.unnotified || '') === '1' || String(req.query.unnotified || '') === 'true';
  res.json({ items: enroll.list({ unnotified }), close_at: enroll.closeAt().toISOString(), open: enroll.isOpen() });
});
app.post('/api/enrollments/:id/notified', apiAuth, (req, res) => {
  if (!enroll.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const changed = enroll.markNotified(req.params.id);
  res.json({ ok: true, id: Number(req.params.id), notified: true, already: !changed });
});
app.post('/api/enrollments/:id/discard', apiAuth, (req, res) => {
  const r = enroll.discard(req.params.id);
  if (!r.ok) return res.status(r.error === 'not found' ? 404 : 409).json(r);
  res.json(r);
});
// New student logins and their temporary passwords, for the welcome-email routine only.
// GET lists pending (or all) rows; POST /:id/sent marks one as emailed. The site itself never sends the email.
app.get('/api/logins/welcome', apiAuth, (req, res) => {
  const pending = String(req.query.pending || '') === '1' || String(req.query.pending || '') === 'true';
  res.json({ items: enroll.listWelcomes({ pending }) });
});
app.post('/api/logins/welcome/:id/sent', apiAuth, (req, res) => {
  if (!enroll.getWelcome(req.params.id)) return res.status(404).json({ error: 'not found' });
  const changed = enroll.markWelcomeSent(req.params.id);
  res.json({ ok: true, id: Number(req.params.id), sent: true, already: !changed });
});
// Inbound homework email (Cloudflare Email Worker posts here). Never sends a reply.
const INBOUND_TOKEN = () => process.env.INBOUND_EMAIL_TOKEN || '';
const inboundAuth = (req, res, next) => {
  const t = INBOUND_TOKEN(); if (t.length < 16) return res.status(503).json({ error: 'INBOUND_EMAIL_TOKEN is not configured on the server.' });
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (got.length !== t.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t))) return res.status(401).json({ error: 'unauthorized' });
  next(); };
app.post('/api/inbound-email', express.json({ limit: '200kb' }), inboundAuth, (req, res) => {
  const from = inbound.parseFrom(req.body?.from);
  const subject = String(req.body?.subject || '').trim();
  let text = String(req.body?.text || '').trim();
  if (!text && req.body?.html) text = inbound.htmlToText(req.body.html);
  const atts = Array.isArray(req.body?.attachments) ? req.body.attachments : (Array.isArray(req.body?.attachments_meta) ? req.body.attachments_meta : []);
  const mediaNote = inbound.formatMediaNote((atts || []).map(a => ({ type: a.type || 'file', filename: a.filename || a.name, mime: a.mime || a.content_type, size: a.size })));
  if (!from) return res.status(400).json({ error: 'from is required' });
  if (!text && !mediaNote) return res.status(400).json({ error: 'text or attachments required' });
  const student = inbound.matchStudentByEmail(from);
  if (!student) {
    const id = inbound.recordUnmatched({ channel: 'email', sender: from, subject, body: text, raw: { subject, attachment_count: (atts || []).length } });
    return res.json({ ok: true, matched: false, unmatched_id: id });
  }
  const filed = inbound.fileHomework({ student, email: from, source: 'email', text, subject, mediaNote });
  if (!filed) return res.status(400).json({ error: 'could not file homework' });
  hw.autoDraft(filed.id).then(ok => ok && persist.schedule('autodraft')).catch(() => {});
  res.json({ ok: true, matched: true, id: filed.id, needs_assignment: filed.needs_assignment });
});

app.set('demo', DEMO);
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(sessions.middleware());
app.use(sessions.studentPersist);
app.use(sessions.csrfGuard);
const flash = (req, msg) => { req.session.flash = msg; };
const need = (...roles) => (req, res, next) => { const u = req.session.user; if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); if (!roles.includes(u.role)) return res.status(403).render('error', { title: 'Not allowed', msg: 'Your account cannot open this page.' }); next(); };
const audit = (req, action, detail) => db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(req.session.user?.id || null, action, JSON.stringify(detail || {}));
const sectionsList = () => db.prepare(`SELECT sec.*, c.code, c.title, c.title_az, t.name teacher FROM sections sec JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id ORDER BY c.code`).all();

// Public
app.get('/healthz', (_q, res) => res.json({ ok: true, app: 'baku-bible-institute', db: db.prepare('SELECT 1 ok').get().ok === 1, demo: DEMO, durable: persist.status().durable }));
const homeLocals = (req, extra = {}) => ({ title: 'Baku Bible Institute', stats: { students: db.prepare(`SELECT COUNT(*) n FROM students WHERE status='active'`).get().n, courses: db.prepare('SELECT COUNT(*) n FROM courses').get().n }, enroll: enroll.pageData(), enrollThanks: String(req.query.tesekkur || '') === '1', enrollErrors: null, enrollValues: {}, ...extra });
app.get('/', (req, res) => res.render('home', homeLocals(req)));
app.post('/enroll', (req, res) => {
  if (enroll.rateLimited(req.ip)) return res.status(429).render('home', homeLocals(req, { enrollErrors: [{ az: 'Bir az sonra yenidən cəhd edin.', en: 'Too many tries from this network. Please wait a few minutes and try again.' }], enrollValues: { name: String(req.body.name||''), phone: String(req.body.phone||''), whatsapp: String(req.body.whatsapp||''), classes: enroll.validate(req.body).codes } }));
  const r = enroll.submit(req.body);
  if (r.spam) return res.redirect('/?tesekkur=1#qeydiyyat');
  if (r.closed) return res.status(403).render('home', homeLocals(req));
  if (!r.ok) return res.status(400).render('home', homeLocals(req, { enrollThanks: false, enrollErrors: r.errors, enrollValues: r.values || {} }));
  audit(req, 'enrollment.request', { id: r.id, student_id: r.student_id, existing: r.existing, enrolled: r.enrolled, full: r.full });
  res.redirect('/?tesekkur=1#qeydiyyat');
});
const loginView = (next, error) => { const n = sessions.localNext(next); const tok = sessions.qrTokenFromNext(n);
  return { title: 'Sign in', error: error || null, next: n, qrNote: !!tok, qrEnroll: tok ? '/qeyd/' + tok + '/qeydiyyat' : null }; };
app.get('/login', (req, res) => { const n = sessions.localNext(req.query.next);
  // A student who is already signed in (e.g. scanned a QR) goes straight back to where they were headed.
  if (req.session.user && n) return res.redirect(n);
  res.render('login', loginView(req.query.next)); });
const attempts = new Map();
app.post('/login', (req, res) => {
  const key = req.ip; const a = attempts.get(key) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).render('login', loginView(req.body.next, 'Too many attempts. Wait 15 minutes.'));
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) { a.n++; attempts.set(key, a); return res.status(401).render('login', loginView(req.body.next, 'Email or password is incorrect.')); }
  attempts.delete(key);
  req.session.regenerate(() => { req.session.user = { id: u.id, name: u.name, role: u.role, email: u.email }; sessions.keepStudent(req.session); const n = sessions.localNext(req.body.next);
    res.redirect(n || (u.role === 'student' ? '/telebe' : u.role === 'teacher' ? '/admin/attendance' : '/admin')); });
});
// Forgot password (all roles). The answer is ALWAYS the same neutral message.
const noReferrer = (_q, res, next) => { res.set('Referrer-Policy', 'no-referrer'); res.set('Cache-Control', 'no-store'); next(); };
app.get('/forgot-password', noReferrer, (req, res) => res.render('forgot-password', { title: 'Forgot password', sent: false, email: '' }));
app.post('/forgot-password', noReferrer, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  // Respond first with the same neutral page in every case; send (or not) in the background.
  res.render('forgot-password', { title: 'Forgot password', sent: true, email: '' });
  pwreset.request(email, req.ip).then(r => {
    if (r.sent) { db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(r.user_id, 'password.reset.request', '{}'); persist.schedule('pw-reset-request'); }
    else if (r.reason === 'email-disabled') console.log('Password reset requested but email sending is off (EMAIL_SENDING_ENABLED/mail credential); nothing sent.');
    else if (r.reason === 'send-failed') console.error('Password reset email failed:', r.error);
    else if (r.reason === 'limited') console.log('Password reset rate-limited.');
  }).catch(e => console.error('Password reset error:', String(e.message).slice(0, 100)));
});
app.get('/reset-password', noReferrer, (req, res) => { const token = String(req.query.token || ''); const ok = !!pwreset.lookup(token);
  res.status(ok ? 200 : 400).render('reset-password', { title: 'Reset password', token: ok ? token : '', invalid: !ok, error: null }); });
app.post('/reset-password', noReferrer, async (req, res) => { const token = String(req.body.token || '');
  const r = pwreset.complete(token, req.body.password, req.body.confirm_password);
  if (r.error === 'invalid') return res.status(400).render('reset-password', { title: 'Reset password', token: '', invalid: true, error: null });
  if (r.error) return res.status(400).render('reset-password', { title: 'Reset password', token, invalid: false,
    error: r.error === 'short' ? 'Password must be at least 8 characters. · Şifrə ən azı 8 simvol olmalıdır.' : 'The two passwords do not match. · İki şifrə eyni deyil.' });
  db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(r.user.id, 'password.reset.complete', '{}');
  await sessions.destroyUserSessions(req.sessionStore, r.user.id);
  persist.schedule('pw-reset-complete');
  delete req.session.user; req.session.flash = 'Your password was changed. Please sign in. · Şifrəniz dəyişdirildi. İndi daxil ola bilərsiniz.';
  res.redirect('/login'); });
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Admin dashboard
const A = need('admin'); const T = need('admin', 'teacher');
app.get('/admin', A, (req, res) => { const r = bots.weeklyReport(); res.render('admin/dashboard', { title: 'Dashboard', r, bots: bots.BOTS, enrollPending: enroll.pendingCount(),
  recentWa: db.prepare(`SELECT * FROM whatsapp_messages ORDER BY received_at DESC LIMIT 5`).all() }); });

// Students
app.get('/admin/students', A, (req, res) => {
  const flags = new Map(bots.unexcused().filter(x => x.n > 2).map(x => [x.id, x]));
  const students = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.student_id=s.id) classes FROM students s ORDER BY s.status='applicant' DESC, s.name`).all().map(s => ({ ...s, flag: flags.get(s.id) }));
  res.render('admin/students', { title: 'Roster', students });
});
app.post('/admin/students', A, (req, res) => { const b = req.body; if (!b.name?.trim()) { flash(req, 'Name is required.'); return res.redirect('/admin/students'); }
  const r = db.prepare('INSERT INTO students (name, preferred_language, phone, whatsapp_phone, email, status, notes) VALUES (?,?,?,?,?,?,?)').run(b.name.trim(), b.preferred_language || 'az', b.phone || null, b.whatsapp_phone || null, b.email || null, b.status || 'applicant', b.notes || null);
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
  db.prepare('UPDATE students SET name=?, preferred_language=?, phone=?, whatsapp_phone=?, email=?, status=?, notes=? WHERE id=?').run(b.name, b.preferred_language || 'az', b.phone || null, b.whatsapp_phone || null, b.email || null, b.status, b.notes || null, req.params.id);
  audit(req, 'student.update', { id: req.params.id }); flash(req, 'Saved.'); res.redirect('/admin/students/' + req.params.id); });
app.post('/admin/students/:id/enroll', A, (req, res) => { db.prepare('INSERT OR IGNORE INTO enrollments (student_id, section_id) VALUES (?,?)').run(req.params.id, req.body.section_id); flash(req, 'Enrolled.'); res.redirect('/admin/students/' + req.params.id); });
app.post('/admin/students/:id/login', A, (req, res) => {
  if (String(req.body.password || '') !== String(req.body.confirm_password || '')) { flash(req, 'Password and confirmation do not match.'); return res.redirect('/admin/students/' + req.params.id); }
  const r = enroll.createLogin(req.params.id, { email: req.body.email, password: req.body.password });
  if (!r.ok) { flash(req, r.error); return res.redirect('/admin/students/' + req.params.id); }
  audit(req, 'student.login.create', { id: Number(req.params.id), user_id: r.user_id });
  flash(req, 'Login created. The welcome email will go out at the next scheduled send (the temporary password is not shown here).');
  res.redirect('/admin/students/' + req.params.id);
});
app.get('/admin/enrollments', A, (req, res) => res.render('admin/enrollments', { title: 'Enrollment requests', wide: true, rows: enroll.list() }));
app.post('/admin/enrollments/:id/notified', A, (req, res) => { enroll.markNotified(req.params.id); flash(req, 'Marked as notified.'); res.redirect('/admin/enrollments'); });
app.post('/admin/enrollments/:id/approve', A, (req, res) => {
  const r = enroll.approve(req.params.id);
  if (!r.ok) { flash(req, r.error || 'Could not approve that request.'); return res.redirect('/admin/enrollments'); }
  audit(req, 'enrollment.approve', { id: Number(req.params.id), student_id: r.student_id, login_created: r.login_created, already: r.already });
  flash(req, r.already ? 'Already approved.' : (r.login_created ? 'Approved. A login was created; the welcome email will go out at the next scheduled send.' : 'Approved. Attendance is now recorded as present.'));
  res.redirect('/admin/enrollments');
});
app.post('/admin/enrollments/:id/reject', A, (req, res) => {
  const r = enroll.reject(req.params.id);
  if (!r.ok) { flash(req, r.error || 'Could not reject that request.'); return res.redirect('/admin/enrollments'); }
  audit(req, 'enrollment.reject', { id: Number(req.params.id), student_id: r.student_id });
  flash(req, 'Request rejected. The pending attendance mark was removed.');
  res.redirect('/admin/enrollments');
});
app.post('/admin/enrollments/:id/discard', A, (req, res) => {
  const r = enroll.discard(req.params.id);
  flash(req, r.ok ? 'Enrollment request removed.' : (r.error || 'Could not remove that request.'));
  if (r.ok) audit(req, 'enrollment.discard', { id: r.id, student_id: r.student_id });
  res.redirect('/admin/enrollments');
});

// Classes
app.get('/admin/classes', T, (req, res) => res.render('admin/classes', { title: 'Classes', sections: db.prepare(`SELECT sec.*, c.code, c.title, c.title_az, t.name teacher, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id=sec.id) n FROM sections sec JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id ORDER BY c.code`).all() }));

// Attendance
app.get('/admin/attendance', T, (req, res) => {
  const sections = sectionsList(); const sid = Number(req.query.section || sections[0]?.id); const date = req.query.date || new Date().toISOString().slice(0, 10);
  const roster = db.prepare(`SELECT s.id, s.name, (SELECT a.status FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE cs.section_id=? AND cs.session_date=? AND a.student_id=s.id) status,
    (SELECT COUNT(*) FROM users u WHERE u.id=s.user_id)=0 no_login FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.section_id=? ORDER BY s.name`).all(sid, date, sid);
  const all = bots.unexcused(); res.render('admin/attendance', { title: 'Attendance', sections, sid, date, roster, flags: all.filter(x => x.n > 2), watch: all.filter(x => x.n === 2) });
});
const markAtt = (section_id, date, student_id, status, note, source) => {
  db.prepare('INSERT OR IGNORE INTO class_sessions (section_id, session_date) VALUES (?,?)').run(section_id, date);
  const ses = db.prepare('SELECT id FROM class_sessions WHERE section_id=? AND session_date=?').get(section_id, date);
  // Re-saving an unchanged mark keeps its origin (e.g. a QR check-in stays 'qr'); a changed mark takes the new source.
  db.prepare(`INSERT INTO attendance (session_id, student_id, status, note, source) VALUES (?,?,?,?,?) ON CONFLICT(session_id, student_id) DO UPDATE SET
    note=CASE WHEN attendance.status=excluded.status THEN COALESCE(excluded.note, attendance.note) ELSE excluded.note END,
    source=CASE WHEN attendance.status=excluded.status THEN attendance.source ELSE excluded.source END,
    recorded_at=CASE WHEN attendance.status=excluded.status THEN attendance.recorded_at ELSE CURRENT_TIMESTAMP END, status=excluded.status`).run(ses.id, student_id, status, note || null, source);
  attqr.recomputeGrades(Number(section_id));
};
const ST = ['present', 'late', 'absent', 'excused'];
app.post('/admin/attendance', T, (req, res) => { const { section_id, date } = req.body;
  for (const [k, v] of Object.entries(req.body)) if (k.startsWith('s_') && ST.includes(v)) markAtt(section_id, date, Number(k.slice(2)), v, null, 'manual');
  audit(req, 'attendance.mark', { section_id, date }); flash(req, 'Attendance saved.'); res.redirect(`/admin/attendance?section=${section_id}&date=${date}`); });

// QR attendance (src/attqr.js). Display/print/images: teachers + admins. Scan: /qeyd/<token> (students, own session only).
const PUBLIC_URL = () => process.env.PUBLIC_URL || (process.env.NODE_ENV === 'production' ? 'https://bakubibleinstitute.org' : '');
const scanUrl = (req, code) => (PUBLIC_URL() || `${req.protocol}://${req.get('host')}`) + '/qeyd/' + code.token;
const qrCtx = (req, res) => { const sid = Number(req.params.sid), week = Number(String(req.params.week).replace(/\D.*$/, ''));
  if (attqr.ensureWindow()) persist.schedule('qr-codes');
  const sec = attqr.sections().find(x => x.id === sid); const code = sec && attqr.getCode(sid, week);
  if (!code) { res.status(404).render('error', { title: 'Not found', msg: 'No check-in code for that class and week. Codes exist for this week and the next four (weeks 1–' + attqr.SESSIONS + ').' }); return null; }
  return { sec, code, url: scanUrl(req, code) }; };
const qrBase = (sid, week) => `/admin/attendance/qr/${sid}/week/${week}`;
app.get('/admin/attendance/qr', T, (req, res) => { if (attqr.ensureWindow()) persist.schedule('qr-codes');
  const wk = attqr.weekOf(); res.render('admin/qrindex', { title: 'QR check-in', wide: true, attqr, week: wk, today: attqr.bakuDate(), term: attqr.termStart(), qrBase,
    classes: attqr.sections().map(s => ({ ...s, codes: attqr.window(s.id) })) }); });
app.post('/admin/attendance/qr/term', T, (req, res) => { const d = String(req.body.term_start || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { flash(req, 'Pick a date.'); return res.redirect('/admin/attendance/qr'); }
  const mon = attqr.mondayOf(d);
  // Codes already used (a session exists) keep their dates; unused ones are rebuilt for the new calendar.
  db.prepare('DELETE FROM attendance_codes WHERE session_id IS NULL').run(); attqr.setMeta('att_term_start', mon); attqr.ensureWindow();
  audit(req, 'attendance.qr_term', { term_start: mon }); flash(req, 'Week 1 now starts Monday ' + attqr.fmtEn(mon) + ' (Baku time). Unused codes were regenerated.'); res.redirect('/admin/attendance/qr'); });
app.get('/admin/attendance/qr/:sid/week/:week.png', T, async (req, res) => { const c = qrCtx(req, res); if (!c) return;
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="BBI-${c.sec.code.replace(/\s+/g, '')}-week${c.code.week_no}-QR.png"` });
  res.type('png').send(await attqr.png(c.url, req.query.size || 1200)); });
app.get('/admin/attendance/qr/:sid/week/:week.svg', T, async (req, res) => { const c = qrCtx(req, res); if (!c) return;
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="BBI-${c.sec.code.replace(/\s+/g, '')}-week${c.code.week_no}-QR${req.query.poster ? '-poster' : ''}.svg"` });
  res.type('image/svg+xml').send(req.query.poster ? await attqr.posterSvg(c.url) : await attqr.svg(c.url)); });
app.get('/admin/attendance/qr/:sid/week/:week/roster.json', T, (req, res) => { const c = qrCtx(req, res); if (!c) return;
  res.set('Cache-Control', 'no-store'); res.json({ live: attqr.isLive(c.code), now_baku: new Date(Date.now() + 4 * 3600e3).toISOString().slice(11, 16), ...attqr.roster(c.code) }); });
const qrView = print => async (req, res) => { const c = qrCtx(req, res); if (!c) return;
  if (attqr.isLive(c.code) && !c.code.session_id) { attqr.sessionFor(c.code); persist.schedule('qr-session'); }
  res.render(print ? 'admin/qrprint' : 'admin/qr', { title: `${c.sec.code} · Week ${c.code.week_no} QR`, wide: true, bodyClass: 'qr-body', ...c, attqr, base: qrBase(c.sec.id, c.code.week_no),
    qr: await attqr.dataUrl(c.url, print ? 1000 : 900), r: attqr.roster(c.code), live: attqr.isLive(c.code), today: attqr.bakuDate() }); };
app.get('/admin/attendance/qr/:sid/week/:week', T, qrView(false));
app.get('/admin/attendance/qr/:sid/week/:week/print', T, qrView(true));
app.get('/admin/attendance/qr/:sid', T, (req, res) => { attqr.ensureWindow(); res.redirect(qrBase(Number(req.params.sid), Math.max(1, Math.min(attqr.SESSIONS, attqr.weekOf())))); });
app.post('/admin/attendance/qr/:sid/week/:week/rotate', T, (req, res) => { const c = qrCtx(req, res); if (!c) return; attqr.rotate(c.sec.id, c.code.week_no);
  audit(req, 'attendance.qr_rotate', { section: c.sec.id, week: c.code.week_no }); flash(req, 'New code made. The old QR for this week no longer works; print or project the new one.'); res.redirect(qrBase(c.sec.id, c.code.week_no)); });
app.post('/admin/attendance/qr/:sid/week/:week/absent', T, (req, res) => { const c = qrCtx(req, res); if (!c) return; const n = attqr.markRestAbsent(c.code);
  audit(req, 'attendance.qr_rest_absent', { section: c.sec.id, week: c.code.week_no, n }); flash(req, n + ' student(s) without a scan marked absent. You can still change any mark on the Attendance page.'); res.redirect(qrBase(c.sec.id, c.code.week_no)); });
// QR self-enrollment (first-time students). Works whenever the weekly token is live; not tied to the homepage form close date.
const qrCodeOrNull = token => attqr.byToken(String(token || '').replace(/[^\w-]/g, '').slice(0, 64));
const qrEnrollLocals = (req, code, extra = {}) => ({ title: 'Qeydiyyat', lang: 'az', code, attqr, live: !!(code && attqr.isLive(code)),
  errors: extra.errors || null, values: extra.values || {}, thanks: !!extra.thanks, hasLogin: !!extra.hasLogin, expired: !!extra.expired });
app.get('/qeyd/:token/qeydiyyat', (req, res) => {
  const token = String(req.params.token || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (req.session.user && req.session.user.role === 'student') return res.redirect('/qeyd/' + token);
  const code = qrCodeOrNull(token);
  if (!code) return res.status(404).render('student/qeydiyyat', qrEnrollLocals(req, null, { expired: true }));
  if (!attqr.isLive(code)) return res.status(410).render('student/qeydiyyat', qrEnrollLocals(req, code, { expired: true }));
  res.render('student/qeydiyyat', qrEnrollLocals(req, code, { thanks: String(req.query.tesekkur || '') === '1' }));
});
app.post('/qeyd/:token/qeydiyyat', (req, res) => {
  const token = String(req.params.token || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (req.session.user && req.session.user.role === 'student') return res.redirect('/qeyd/' + token);
  const code = qrCodeOrNull(token);
  if (!code || !attqr.isLive(code)) return res.status(410).render('student/qeydiyyat', qrEnrollLocals(req, code, { expired: true }));
  if (enroll.rateLimited(req.ip)) return res.status(429).render('student/qeydiyyat', qrEnrollLocals(req, code, { errors: [{ az: 'Bir az sonra yenidən cəhd edin.', en: 'Too many tries from this network. Please wait a few minutes and try again.' }], values: { name: String(req.body.name||''), email: String(req.body.email||''), whatsapp: String(req.body.whatsapp||''), note: String(req.body.note||'') } }));
  const r = enroll.submitQr(req.body, code);
  if (r.spam) return res.redirect('/qeyd/' + token + '/qeydiyyat?tesekkur=1');
  if (r.has_login) return res.status(400).render('student/qeydiyyat', qrEnrollLocals(req, code, { hasLogin: true, values: r.values || {} }));
  if (!r.ok) return res.status(400).render('student/qeydiyyat', qrEnrollLocals(req, code, { errors: r.errors || [{ az: 'Zəhmət olmasa formu yoxlayın.', en: 'Please check the form.' }], values: r.values || {} }));
  audit(req, 'enrollment.qr_self', { id: r.id, student_id: r.student_id, existing: r.existing, section: code.section_id, week: code.week_no, already: r.already });
  res.redirect('/qeyd/' + token + '/qeydiyyat?tesekkur=1');
});

// Student scan
const CHECKIN_MSG = { marked: ['ok', 'Davamiyyətiniz qeyd olundu.'], already: ['ok', 'Davamiyyətiniz artıq qeyd olunub.'],
  teacher_mark: ['ok', 'Bu dərs üçün davamiyyətinizi müəllim artıq qeyd edib. Sualınız varsa, müəllimə yazın.'],
  expired: ['err', 'Bu QR kodun vaxtı bitib. Zəhmət olmasa, bu həftənin yeni kodunu skan edin.'], not_yet: ['err', 'Bu QR kod hələ aktiv deyil. Zəhmət olmasa, dərs həftəsində skan edin.'],
  invalid: ['err', 'Bu QR kod tanınmadı. Zəhmət olmasa, sinifdə göstərilən kodu yenidən skan edin.'], not_enrolled: ['err', 'Siz bu sinifdə qeydiyyatda deyilsiniz. Zəhmət olmasa, müəllimə müraciət edin.'],
  not_student: ['err', 'Bu səhifə tələbələr üçündür. Zəhmət olmasa, tələbə hesabınızla daxil olun.'] };
app.get('/qeyd/:token', (req, res) => { const u = req.session.user;
  // Not signed in yet: sign in once, then come straight back here and the scan is recorded (no button).
  if (!u) return res.redirect('/login?next=' + encodeURIComponent('/qeyd/' + String(req.params.token).replace(/[^\w-]/g, '').slice(0, 64)));
  const r = attqr.checkIn(req.params.token, u); if (r.kind === 'marked') { persist.schedule('qr-checkin'); audit(req, 'attendance.qr_checkin', { section: r.code.section_id, week: r.code.week_no }); }
  const [tone, msg] = CHECKIN_MSG[r.kind]; res.status(tone === 'ok' ? 200 : r.kind === 'not_student' ? 403 : 410 - (r.kind === 'invalid' ? 6 : 0));
  res.set('Cache-Control', 'no-store');
  res.render('student/checkin', { title: 'Davamiyyət', lang: 'az', tone, msg, kind: r.kind, code: r.code || null, attqr, when: (r.kind === 'marked' || r.kind === 'already') ? attqr.bakuStamp(r.at) : null,
    name: r.student ? String(r.student.name).split(' ')[0] : '' }); });

// Gradebook
app.get('/admin/gradebook', T, (req, res) => { if (grades.ensureItems()) persist.schedule('grade-items'); res.render('admin/gradebook', { title: 'Gradebook', sections: sectionsList(), grades, items: db.prepare(`SELECT gi.*, ${grades.CAT} cat, c.code, sec.id sid, (SELECT a.id FROM assignments a WHERE a.grade_item_id=gi.id) assignment_id, (SELECT COUNT(*) FROM grades g WHERE g.grade_item_id=gi.id AND g.points IS NOT NULL) graded, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id=gi.section_id) n FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id ORDER BY c.code, gi.due_date, gi.id`).all() }); });
app.get('/admin/gradebook/:id', T, (req, res) => { const item = db.prepare(`SELECT gi.*, ${grades.CAT} cat, c.code, c.title course FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE gi.id=?`).get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not found', msg: 'No such grade item.' });
  res.render('admin/gradeitem', { title: item.title, item, grades, locked: !!db.prepare('SELECT 1 FROM assignments WHERE grade_item_id=?').get(item.id), rows: db.prepare(`SELECT s.id, s.name, g.points, g.comment FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN grades g ON g.grade_item_id=? AND g.student_id=s.id WHERE e.section_id=? ORDER BY s.name`).all(item.id, item.section_id) }); });
const setGrade = (item, student, points, comment, source) => db.prepare(`INSERT INTO grades (grade_item_id, student_id, points, comment, source) VALUES (?,?,?,?,?) ON CONFLICT(grade_item_id, student_id) DO UPDATE SET points=excluded.points, comment=COALESCE(excluded.comment, comment), source=excluded.source, updated_at=CURRENT_TIMESTAMP`).run(item, student, points, comment || null, source);
// Graded items that are not homework (exams, quizzes, participation…). Homework items come from /admin/assignments.
app.post('/admin/gradebook', T, (req, res) => { const b = req.body; const sec = db.prepare('SELECT id FROM sections WHERE id=?').get(b.section_id);
  const max = Number(b.max_points), w = b.weight === '' || b.weight == null ? 1 : Number(b.weight);
  if (!sec || !String(b.title || '').trim() || !(max > 0) || !(w >= 0)) { flash(req, 'Not saved: pick a class, a title, max points > 0 and weight ≥ 0.'); return res.redirect('/admin/gradebook'); }
  const kind = grades.KINDS.includes(b.kind) ? b.kind : 'other';
  const id = db.prepare('INSERT INTO grade_items (section_id, title, max_points, due_date, weight, kind) VALUES (?,?,?,?,?,?)').run(sec.id, String(b.title).trim(), max, b.due_date || null, w, kind).lastInsertRowid;
  audit(req, 'gradeitem.create', { id }); flash(req, 'Graded item added.'); res.redirect('/admin/gradebook/' + id); });
app.post('/admin/gradebook/:id/edit', T, (req, res) => { const b = req.body; const max = Number(b.max_points), w = Number(b.weight);
  if (!String(b.title || '').trim() || !(max > 0) || !(w >= 0)) { flash(req, 'Not saved: title, max points > 0 and weight ≥ 0 are required.'); return res.redirect('/admin/gradebook/' + req.params.id); }
  db.prepare('UPDATE grade_items SET title=?, max_points=?, weight=?, due_date=? WHERE id=?').run(String(b.title).trim(), max, w, b.due_date || null, req.params.id);
  const cur = db.prepare('SELECT kind FROM grade_items WHERE id=?').get(req.params.id);
  if (cur && cur.kind !== 'attendance' && grades.KINDS.includes(b.kind) && !db.prepare('SELECT 1 FROM assignments WHERE grade_item_id=?').get(req.params.id)) db.prepare('UPDATE grade_items SET kind=? WHERE id=?').run(b.kind, req.params.id);
  db.prepare('UPDATE assignments SET max_points=? WHERE grade_item_id=?').run(max, req.params.id);
  audit(req, 'gradeitem.update', { id: req.params.id }); flash(req, 'Item updated.'); res.redirect('/admin/gradebook/' + req.params.id); });
app.post('/admin/gradebook/:id/delete', A, (req, res) => { if (req.body.confirm !== 'yes') { flash(req, 'Tick the confirmation box to delete this item and its grades.'); return res.redirect('/admin/gradebook/' + req.params.id); }
  db.transaction(() => { db.prepare('DELETE FROM assignments WHERE grade_item_id=?').run(req.params.id); db.prepare('DELETE FROM grade_items WHERE id=?').run(req.params.id); })();
  audit(req, 'gradeitem.delete', { id: req.params.id }); flash(req, 'Item deleted.'); res.redirect('/admin/gradebook'); });
app.get('/admin/gradebook/class/:sid', T, (req, res) => { const sec = sectionsList().find(x => x.id === Number(req.params.sid)); if (!sec) return res.status(404).render('error', { title: 'Not found', msg: 'No such class.' });
  if (grades.ensureItems(sec.id)) persist.schedule('grade-items');
  res.render('admin/classgrades', { title: sec.code + ' grades', sec, board: grades.sectionBoard(sec.id), grades }); });
app.post('/admin/gradebook/class/:sid/scheme', A, (req, res) => { const sec = sectionsList().find(x => x.id === Number(req.params.sid)); if (!sec) return res.sendStatus(404);
  const v = grades.validateScheme(req.body); if (v.error) { flash(req, 'Not saved: ' + v.error); return res.redirect('/admin/gradebook/class/' + sec.id); }
  grades.saveScheme(sec.id, v.s); audit(req, 'gradescheme.update', { section: sec.id, ...v.s }); flash(req, 'Grading scheme saved for ' + sec.code + '.'); res.redirect('/admin/gradebook/class/' + sec.id); });
app.post('/admin/enrollments/:id/final', A, (req, res) => { const v = String(req.body.final_grade || '').trim().slice(0, 20) || null;
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(req.params.id); if (!e) return res.sendStatus(404);
  db.prepare('UPDATE enrollments SET final_grade=? WHERE id=?').run(v, e.id); audit(req, 'enrollment.final_grade', { id: e.id });
  flash(req, 'Final grade saved.'); const back = String(req.body.back || ''); res.redirect(back.startsWith('/admin/') ? back : '/admin/students/' + e.student_id); });
app.post('/admin/gradebook/:id', T, (req, res) => { const cur = new Map(db.prepare('SELECT student_id, points FROM grades WHERE grade_item_id=?').all(req.params.id).map(g => [g.student_id, g.points]));
  // Only changed scores are written (so re-saving keeps automatic attendance scores automatic); a typed change becomes a manual override.
  for (const [k, v] of Object.entries(req.body)) if (k.startsWith('p_') && v !== '' && cur.get(Number(k.slice(2))) !== Number(v)) setGrade(req.params.id, Number(k.slice(2)), Number(v), null, 'manual');
  for (const [k, v] of Object.entries(req.body)) if (k.startsWith('c_')) { const c = String(v).trim().slice(0, 2000) || null; const sid = Number(k.slice(2));
    if (c) db.prepare(`INSERT INTO grades (grade_item_id, student_id, comment, source) VALUES (?,?,?, 'manual') ON CONFLICT(grade_item_id, student_id) DO UPDATE SET comment=excluded.comment, updated_at=CURRENT_TIMESTAMP`).run(req.params.id, sid, c);
    else db.prepare('UPDATE grades SET comment=NULL WHERE grade_item_id=? AND student_id=?').run(req.params.id, sid); }
  audit(req, 'grades.save', { item: req.params.id }); flash(req, 'Grades saved.'); res.redirect('/admin/gradebook/' + req.params.id); });

// Homework review
const subQ = `SELECT sb.*, s.name student, s.preferred_language, a.title_az, a.instructions_az, a.grade_item_id, c.code, cr.draft_az, cr.final_az, cr.is_sample, cr.drafted_by, cr.points cpoints, cr.approved_at FROM submissions sb JOIN students s ON s.id=sb.student_id JOIN assignments a ON a.id=sb.assignment_id JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN corrections cr ON cr.submission_id=sb.id`;
app.get('/admin/homework', T, (req, res) => res.render('admin/homework', { title: 'Homework review', anytime: hw.all(), builtInAi: hw.llmEnabled(), sourceLabel: inbound.sourceLabel, unmatched: req.session.user.role==='admin' ? inbound.unmatchedCount() : 0, subs: db.prepare(subQ + ` ORDER BY sb.status='returned', sb.submitted_at DESC`).all() }));
// Anytime homework: Bruce edits + approves the English correction; only then is it translated to Azeri and returned.
const hwOr404 = (req, res) => { const s = hw.get(req.params.id); if (!s) res.status(404).render('error', { title: 'Not found', msg: 'No such submission.' }); return s; };
app.get('/admin/homework/anytime/:id', T, (req, res) => { const s = hwOr404(req, res); if (!s) return; res.render('admin/anytime', { title: 'Homework · ' + s.title, s, qa: lessons.overview(s.id), late, builtInAi: hw.llmEnabled(), sourceLabel: inbound.sourceLabel, assignments: inbound.assignmentsFor(s.student_id) }); });

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
// Lessons (class-session summaries) and five-question assignments. Drafts are invisible to students until published here.
function publishAssignment(aid, { due, max, policy }) { const a = lessons.assignment(aid); if (!a) return 0; let n = 0;
  const dueDate = late.bakuParts(due).date; const pol = policy || a.late_policy || late.DEFAULT_POLICY;
  db.transaction(() => { let gi = a.grade_item_id; if (!gi) gi = db.prepare('INSERT INTO grade_items (section_id, title, max_points, due_date) VALUES (?,?,?,?)').run(a.section_id, a.title_az, max, dueDate).lastInsertRowid;
    else db.prepare('UPDATE grade_items SET title=?, max_points=?, due_date=? WHERE id=?').run(a.title_az, max, dueDate, gi);
    db.prepare('UPDATE assignments SET published=1, due_at=?, due_date=?, max_points=?, late_policy=?, grade_item_id=? WHERE id=?').run(due, dueDate, max, pol, gi, a.id);
    if (a.lesson_id) db.prepare(`UPDATE lessons SET status='published', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(a.lesson_id);
    for (const st of db.prepare(`SELECT s.name, COALESCE(s.email, u.email) email FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN users u ON u.id=s.user_id WHERE e.section_id=? AND s.status='active'`).all(a.section_id)) {
      const t = outbox.tplAssignment({ name: st.name, code: a.code, title: a.title_az, due: late.fmtBaku(due), instructions: a.instructions_az }); if (outbox.queue({ to: st.email, name: st.name, subject: t.subject, text: t.text, kind: 'assignment_notice', ref: 'assignment:' + a.id })) n++; } })();
  return n; }
const lessonOr404 = (req, res) => { const l = lessons.lesson(req.params.id); if (!l) res.status(404).render('error', { title: 'Not found', msg: 'No such lesson.' }); return l; };
app.get('/admin/lessons', T, (req, res) => res.render('admin/lessons', { title: 'Lessons & questions', list: lessons.lessons(), sections: sectionsList(), notesList: notes.all(), today: attqr.bakuDate() }));
app.post('/admin/lessons', T, (req, res) => { const b = req.body; const sec = db.prepare('SELECT id FROM sections WHERE id=?').get(b.section_id);
  const src = ['paste', 'pocket', 'note'].includes(b.source) ? b.source : 'paste'; const text = String(b.source_text || '').trim(); const title = String(b.title || '').trim();
  if (!sec || !title) { flash(req, 'Pick a class and give the lesson a title.'); return res.redirect('/admin/lessons'); }
  if (src === 'paste' && !text) { flash(req, 'Paste the class summary or notes (or choose Pocket / class note).'); return res.redirect('/admin/lessons'); }
  if (src === 'note' && !notes.get(b.note_slug)) { flash(req, 'Pick a class note.'); return res.redirect('/admin/lessons'); }
  const r = lessons.createLesson({ section_id: sec.id, title, title_az: String(b.title_az || '').trim() || null, session_date: /^\d{4}-\d{2}-\d{2}$/.test(b.session_date) ? b.session_date : null, source: src,
    source_ref: src === 'pocket' ? (String(b.pocket_title || '').trim() || title) : src === 'note' ? b.note_slug : null, source_text: src === 'note' ? notes.get(b.note_slug).body : text || null, note_slug: notes.get(b.note_slug) ? b.note_slug : null, created_by: req.session.user.name });
  audit(req, 'lesson.create', { id: r.id }); flash(req, r.existed ? 'That lesson already exists.' : 'Lesson saved. The homework assistant will write the summary and five questions on its next run; you review and publish them here.');
  res.redirect('/admin/lessons/' + r.id); });
app.get('/admin/lessons/:id', T, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const a = l.assignment_id ? lessons.assignment(l.assignment_id) : null;
  res.render('admin/lesson', { title: l.title, l, a, qs: a ? lessons.questions(a.id) : [], late, nsub: a ? lessons.submissionsFor(a.id).length : 0, notesList: notes.all(), N: lessons.N_Q }); });
app.post('/admin/lessons/:id', T, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const b = req.body; const t = v => String(v || '').trim();
  db.prepare('UPDATE lessons SET title=?, title_az=?, session_date=?, summary_en=?, summary_az=?, outline=?, show_in_notes=?, note_slug=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(t(b.title) || l.title, t(b.title_az) || null, /^\d{4}-\d{2}-\d{2}$/.test(b.session_date) ? b.session_date : l.session_date, t(b.summary_en) || null, t(b.summary_az) || null, t(b.outline) || null, b.show_in_notes ? 1 : 0, notes.get(b.note_slug) ? b.note_slug : null, l.id);
  if (l.status === 'needs_summary' && t(b.summary_en) && t(b.outline)) db.prepare(`UPDATE lessons SET status='needs_questions', summary_by=? WHERE id=?`).run(req.session.user.name, l.id);
  const qs = Array.from({ length: lessons.N_Q }, (_, i) => ({ en: t(b['q' + (i + 1) + '_en']), az: t(b['q' + (i + 1) + '_az']) }));
  let msg = 'Saved.';
  if (qs.some(q => q.en || q.az)) { const a = l.assignment_id && lessons.assignment(l.assignment_id);
    if (a && a.published) { const up = db.prepare('UPDATE assignment_questions SET text_en=?, text_az=? WHERE assignment_id=? AND n=?'); qs.forEach((q, i) => q.en && q.az && up.run(q.en, q.az, a.id, i + 1)); msg = 'Saved. Students now see the updated question text.'; }
    else { const r = lessons.setQuestions(l.id, qs, { by: req.session.user.name }); if (r.error) msg = 'Summary saved; questions not saved: fill in all five questions in English and Azeri.'; } }
  if (l.assignment_id && t(b.title_az)) db.prepare('UPDATE assignments SET title_az=? WHERE id=? AND published=0').run(t(b.title_az), l.assignment_id);
  audit(req, 'lesson.update', { id: l.id }); flash(req, msg); res.redirect('/admin/lessons/' + l.id); });
app.post('/admin/lessons/:id/requeue', T, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const to = req.body.to === 'needs_summary' ? 'needs_summary' : 'needs_questions';
  if (l.status === 'published') { flash(req, 'Already published; edit the text directly instead.'); return res.redirect('/admin/lessons/' + l.id); }
  db.prepare('UPDATE lessons SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(to, l.id); audit(req, 'lesson.requeue', { id: l.id, to });
  flash(req, to === 'needs_summary' ? 'Sent back to the assistant to rewrite the summary and outline.' : 'Sent back to the assistant to rewrite the five questions.'); res.redirect('/admin/lessons/' + l.id); });
app.post('/admin/lessons/:id/publish', T, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const a = l.assignment_id && lessons.assignment(l.assignment_id);
  if (!a || lessons.questions(a.id).length !== lessons.N_Q) { flash(req, 'Add all five questions first.'); return res.redirect('/admin/lessons/' + l.id); }
  const due = late.bakuToUtcIso(req.body.due_date, req.body.due_time); const max = Number(req.body.max_points || lessons.MAX_POINTS);
  if (!due || !(max > 0)) { flash(req, 'Pick a due date and time (Baku) and max points.'); return res.redirect('/admin/lessons/' + l.id); }
  let pol; try { pol = late.normalizePolicy(String(req.body.late_policy || '').trim() || late.DEFAULT_POLICY); } catch (e) { flash(req, e.message); return res.redirect('/admin/lessons/' + l.id); }
  const n = a.published ? null : publishAssignment(a.id, { due, max, policy: pol });
  if (a.published) { db.prepare('UPDATE assignments SET due_at=?, due_date=?, max_points=?, late_policy=? WHERE id=?').run(due, late.bakuParts(due).date, max, pol, a.id); if (a.grade_item_id) db.prepare('UPDATE grade_items SET max_points=?, due_date=? WHERE id=?').run(max, late.bakuParts(due).date, a.grade_item_id); }
  audit(req, 'lesson.publish', { id: l.id, assignment: a.id });
  flash(req, a.published ? 'Due date and points updated.' : `Published. Students in ${l.code} now see the summary and five questions on their kabinet. ${n} Azeri email notice(s) are waiting in the Outbox for your approval — nothing has been sent.`);
  res.redirect('/admin/lessons/' + l.id); });
app.post('/admin/lessons/:id/unpublish', A, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const a = l.assignment_id && lessons.assignment(l.assignment_id);
  if (!a || !a.published) return res.redirect('/admin/lessons/' + l.id);
  if (lessons.submissionsFor(a.id).length) { flash(req, 'Students have already submitted answers, so it stays published.'); return res.redirect('/admin/lessons/' + l.id); }
  db.transaction(() => { db.prepare(`DELETE FROM email_outbox WHERE ref=? AND status='pending'`).run('assignment:' + a.id); db.prepare('UPDATE assignments SET published=0, grade_item_id=NULL WHERE id=?').run(a.id);
    if (a.grade_item_id) db.prepare('DELETE FROM grade_items WHERE id=? AND id NOT IN (SELECT grade_item_id FROM grades)').run(a.grade_item_id); db.prepare(`UPDATE lessons SET status='draft_ready' WHERE id=?`).run(l.id); })();
  audit(req, 'lesson.unpublish', { id: l.id }); flash(req, 'Back to draft. Students no longer see it; unsent notices were removed from the Outbox.'); res.redirect('/admin/lessons/' + l.id); });
app.post('/admin/lessons/:id/delete', A, (req, res) => { const l = lessonOr404(req, res); if (!l) return; const a = l.assignment_id && lessons.assignment(l.assignment_id);
  if (req.body.confirm !== 'yes') { flash(req, 'Tick the confirmation box to delete this lesson.'); return res.redirect('/admin/lessons/' + l.id); }
  if (a && (a.published || lessons.submissionsFor(a.id).length)) { flash(req, 'Unpublish first (only possible before any submissions).'); return res.redirect('/admin/lessons/' + l.id); }
  db.transaction(() => { if (a) db.prepare('DELETE FROM assignments WHERE id=?').run(a.id); db.prepare('DELETE FROM lessons WHERE id=?').run(l.id); })();
  audit(req, 'lesson.delete', { id: l.id }); flash(req, 'Lesson deleted.'); res.redirect('/admin/lessons'); });
app.get('/admin/homework/assignment/:aid', T, (req, res) => { const a = lessons.assignment(req.params.aid); if (!lessons.isQA(a)) return res.status(404).render('error', { title: 'Not found', msg: 'Not a five-question assignment.' });
  const subs = lessons.submissionsFor(a.id).map(id => lessons.overview(id)); const enrolled = db.prepare(`SELECT s.id, s.name FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.section_id=? AND s.status='active' ORDER BY s.name`).all(a.section_id);
  const done = new Set(db.prepare('SELECT DISTINCT student_id FROM hw_submissions WHERE assignment_id=?').all(a.id).map(r => r.student_id));
  res.render('admin/qaoverview', { title: a.code + ' · ' + a.title_az, a, qs: lessons.questions(a.id), subs, missing: enrolled.filter(s => !done.has(s.id)), late, sourceLabel: inbound.sourceLabel }); });
app.post('/admin/homework/anytime/:id/save', T, (req, res) => { const s = hwOr404(req, res); if (!s) return;
  if (!hw.saveEdit(s.id, String(req.body.final_en || '').trim() || null)) flash(req, 'This homework was already returned; it can no longer be edited.'); else flash(req, 'Edits saved. Nothing has been sent to the student.');
  res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/approve', T, async (req, res) => { const s = hwOr404(req, res); if (!s) return;
  const text = String(req.body.final_en || '').trim();
  const plan = hw.planApprove(s.id, { score: req.body.raw_score, override: req.body.final_override, reviewed: req.body.reviewed, final_en: text, by: req.session.user.name });
  if (!plan.ok) {
    if (plan.code !== 409 && text) hw.saveEdit(s.id, text);
    flash(req, plan.needs_review ? 'Edits saved. Tick “I have reviewed and edited this correction” to approve.' : plan.error);
    return res.redirect('/admin/homework/anytime/' + s.id);
  }
  const r = hw.applyApprove(plan); if (!r.ok) { flash(req, r.error); return res.redirect('/admin/homework/anytime/' + s.id); }
  audit(req, 'homework.anytime.approve', { id: s.id });
  const done = await hw.autoReturn(s.id);
  flash(req, done ? 'Approved. The Azeri version was created and returned to the student.' : 'Approved. Your English correction is queued for Azeri translation; the student will see it once it is translated.');
  res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/unapprove', T, (req, res) => { const s = hwOr404(req, res); if (!s) return;
  flash(req, hw.unapprove(s.id) ? 'Approval withdrawn. Nothing will be translated or returned until you approve again.' : 'Cannot withdraw: it was already returned.');
  audit(req, 'homework.anytime.unapprove', { id: s.id }); res.redirect('/admin/homework/anytime/' + s.id); });
app.post('/admin/homework/anytime/:id/delete', A, (req, res) => { const s = hwOr404(req, res); if (!s) return; hw.remove(s.id); audit(req, 'homework.anytime.delete', { id: s.id }); flash(req, 'Submission deleted.'); res.redirect('/admin/homework'); });
app.post('/admin/homework/anytime/:id/assignment', T, (req, res) => { const s = hwOr404(req, res); if (!s) return;
  const a = db.prepare(`SELECT a.*, c.code FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id WHERE a.id=?`).get(req.body.assignment_id);
  if (!a) { flash(req, 'Pick an assignment.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  if (s.student_id && !db.prepare(`SELECT 1 FROM enrollments e JOIN assignments a ON a.section_id=e.section_id WHERE e.student_id=? AND a.id=?`).get(s.student_id, a.id)) {
    flash(req, 'That assignment is not in this student\'s classes.'); return res.redirect('/admin/homework/anytime/' + s.id); }
  if (!hw.setAssignment(s.id, a)) flash(req, 'Could not attach the assignment (already returned?).');
  else { lessons.onFiled(s.id); audit(req, 'homework.anytime.assignment', { id: s.id, assignment_id: a.id }); flash(req, 'Assignment attached: ' + a.code + ' · ' + a.title_az + '. Late deduction was recalculated.'); }
  res.redirect('/admin/homework/anytime/' + s.id); });

app.get('/admin/inbound', A, (req, res) => { const status = ['pending','filed','dismissed','all'].includes(req.query.status) ? req.query.status : 'pending';
  res.render('admin/inbound', { title: 'Unmatched inbound', status, items: inbound.unmatchedList(status), students: db.prepare(`SELECT id, name FROM students WHERE status='active' ORDER BY name`).all() }); });
app.post('/admin/inbound/:id/dismiss', A, (req, res) => { inbound.dismissUnmatched(req.params.id); flash(req, 'Dismissed.'); res.redirect('/admin/inbound'); });
app.post('/admin/inbound/:id/file', A, (req, res) => {
  const item = inbound.unmatchedGet(req.params.id); if (!item || item.status !== 'pending') { flash(req, 'Already handled.'); return res.redirect('/admin/inbound'); }
  const st = db.prepare(`SELECT s.*, u.email AS user_email FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(req.body.student_id);
  if (!st) { flash(req, 'Pick a student.'); return res.redirect('/admin/inbound'); }
  const filed = inbound.fileHomework({ student: st, email: st.email || st.user_email, source: item.channel === 'whatsapp' ? 'whatsapp' : 'email', text: item.body, subject: item.subject });
  if (!filed) { flash(req, 'Could not file (empty body?).'); return res.redirect('/admin/inbound'); }
  inbound.markUnmatchedFiled(item.id, st.id, filed.id);
  hw.autoDraft(filed.id).then(ok => ok && persist.schedule('autodraft')).catch(() => {});
  audit(req, 'inbound.file', { id: item.id, hw: filed.id }); flash(req, 'Filed as homework.'); res.redirect('/admin/homework/anytime/' + filed.id); });

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
app.post('/admin/whatsapp/test', A, (req, res) => { const r = wa.ingest({ from: req.body.from, name: req.body.name, text: req.body.text, media: req.body.media ? [{ type: req.body.media }] : [] }, { demo: true });
  const n = (r.homework || []).length;
  flash(req, 'Test message added to the inbox.' + (n ? ' Homework was filed automatically for review.' : ''));
  for (const h of r.homework || []) hw.autoDraft(h.hwId).then(ok => ok && persist.schedule('autodraft')).catch(() => {});
  res.redirect('/admin/whatsapp'); });
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
      else if (action === 'file_homework') { if (!b.student_id) throw new Error('Pick a student');
        const st = db.prepare(`SELECT s.*, u.email AS user_email FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(b.student_id);
        const asg = b.assignment_id ? db.prepare(`SELECT a.*, c.code FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id WHERE a.id=?`).get(b.assignment_id) : null;
        if (!st) throw new Error('Student not found');
        const filed = inbound.fileHomework({ student: st, email: st.email || st.user_email, source: 'whatsapp', text: m.body, assignmentOverride: asg || undefined, source_ref: 'whatsapp:' + m.id });
        if (!filed) throw new Error('Nothing to file');
        note = filed.needs_assignment ? 'Homework filed for review — pick the assignment on the homework page.' : 'Homework filed for review.';
        req._filedHw = filed.id; }
      else throw new Error('Choose an action');
      if (b.student_id && !m.student_id) db.prepare('UPDATE whatsapp_messages SET student_id=? WHERE id=?').run(b.student_id, m.id);
      db.prepare(`UPDATE whatsapp_messages SET status='applied', suggested_action=?, handled_by=?, handled_at=CURRENT_TIMESTAMP WHERE id=?`).run(action, req.session.user.id, m.id);
    })();
    audit(req, 'whatsapp.apply', { id: m.id, action }); flash(req, note);
    if (req._filedHw) hw.autoDraft(req._filedHw).then(ok => ok && persist.schedule('autodraft')).catch(() => {});
  } catch (e) { flash(req, 'Not applied: ' + e.message); }
  res.redirect('/admin/whatsapp');
});

// Email outbox: nothing is sent unless Bruce clicks Send here (and EMAIL_SENDING_ENABLED=true).
app.get('/admin/outbox', A, (req, res) => { const status = ['pending', 'sent', 'failed', 'discarded', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.render('admin/outbox', { title: 'Email outbox', status, msgs: outbox.list(status), counts: outbox.counts(), cfg: outbox.cfg(), check: req.session.mailCheck || null, sections: sectionsList() }); delete req.session.mailCheck; });
app.post('/admin/outbox/verify', A, async (req, res) => { req.session.mailCheck = await outbox.verify(); res.redirect('/admin/outbox'); });
app.post('/admin/outbox/:id/send', A, async (req, res) => { const r = await outbox.send(Number(req.params.id), req.session.user.name); audit(req, 'outbox.send', { id: req.params.id, ok: r.ok });
  flash(req, r.ok ? 'Email sent.' : 'Not sent: ' + r.error); res.redirect('/admin/outbox'); });
// Queue (never send) a one-off notice to every active student in the given sections; {name} and optional {opening} are replaced per student. Bruce approves on /admin/outbox.
app.post('/admin/outbox/compose', A, (req, res) => { const ids = [].concat(req.body.section_ids || []).map(Number).filter(Boolean); const subject = String(req.body.subject || '').trim().slice(0, 200); const body = String(req.body.body_text || '');
  const channel = String(req.body.channel || 'email').trim().toLowerCase();
  if (channel && channel !== 'email') { flash(req, 'Only the email channel can be queued from this form.'); return res.redirect('/admin/outbox'); }
  if (!ids.length || !subject || !body.trim()) { flash(req, 'Pick classes, a subject and a message.'); return res.redirect('/admin/outbox'); }
  const students = db.prepare(`SELECT s.id, s.name, COALESCE(s.email, u.email) email FROM enrollments e JOIN students s ON s.id=e.student_id LEFT JOIN users u ON u.id=s.user_id WHERE e.section_id IN (${ids.map(() => '?').join(',')}) AND s.status='active'`).all(...ids);
  const { items, unmatched, skipped } = outbox.composeItems(students, { subject, body, openingsText: req.body.openings });
  let n = 0;
  for (const it of items) { if (outbox.queue({ to: it.to, name: it.name, subject: it.subject, text: it.text, kind: 'notice', ref: 'compose:' + ids.join(',') })) n++; }
  audit(req, 'outbox.compose', { sections: ids, n }); flash(req, outbox.formatComposeFlash({ n, unmatched, skipped })); res.redirect('/admin/outbox'); });
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
app.get('/telebe/sifre', S, (req, res) => res.render('student/sifre', { title: 'Şifrə', lang: 'az' }));
app.post('/telebe/sifre', S, (req, res) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id); const n = String(req.body.new_password || '');
  if (!u || !bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) { flash(req, 'İndiki şifrə düzgün deyil. Zəhmət olmasa, yenidən yoxlayın.'); return res.redirect('/telebe/sifre'); }
  if (n.length < 12 || n !== String(req.body.confirm_password || '')) { flash(req, 'Yeni şifrə ən azı 12 simvol olmalıdır və hər iki yerdə eyni yazılmalıdır.'); return res.redirect('/telebe/sifre'); }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(n, 10), u.id); audit(req, 'password.change', { via: 'telebe' }); flash(req, 'Şifrəniz dəyişdirildi. İndi yeni şifrənizlə daxil ola bilərsiniz.'); res.redirect('/telebe/sifre'); });
app.get('/telebe', S, (req, res) => { const s = me(req); if (!s) return res.render('error', { title: 'Xəta', msg: 'Tələbə profili tapılmadı.' });
  res.render('student/home', { title: 'Tələbə kabineti', s, lang: 'az',
    classes: db.prepare(`SELECT c.code, c.title_az, sec.schedule, sec.room, t.name teacher FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id LEFT JOIN teachers t ON t.id=sec.teacher_id WHERE e.student_id=?`).all(s.id),
    att: db.prepare(`SELECT a.status, COUNT(*) n FROM attendance a WHERE a.student_id=? GROUP BY a.status`).all(s.id),
    avgs: grades.averages(s.id),
    grades: db.prepare(`SELECT gi.title, gi.max_points, gi.weight, ${grades.CAT} cat, g.points, g.comment, c.code FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id WHERE g.student_id=?`).all(s.id),
    mine: hw.forStudent(req.session.user.email),
    courses: (() => { const mineC = db.prepare(`SELECT c.code, c.title_az, c.title FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=? ORDER BY c.code`).all(s.id);
      return mineC.length ? mineC : db.prepare('SELECT code, title_az, title FROM courses ORDER BY code').all(); })(),
    late, nowIso: new Date().toISOString(),
    hw: db.prepare(`SELECT a.*, c.code, (SELECT COUNT(*) FROM hw_submissions h WHERE h.assignment_id=a.id AND h.student_email=?) nmine FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=sec.id AND e.student_id=? WHERE COALESCE(a.published,1)=1 ORDER BY COALESCE(a.due_at, a.due_date)`).all(String(req.session.user.email).toLowerCase(), s.id) }); });
// Submit for a specific assignment. Never blocked by the due date; late work gets the assignment's deduction.
// Five-question assignments: the student reads the class summary and answers three of the five questions.
const qaFor = (req) => { const s = me(req); const a = s && db.prepare(`SELECT a.*, c.code, c.title_az course_az FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=a.section_id AND e.student_id=? WHERE a.id=? AND a.kind='qa5' AND a.published=1`).get(s.id, req.params.id); return { s, a }; };
app.get('/telebe/tapsiriq/:id', S, (req, res) => { const { s, a } = qaFor(req); if (!a) return res.status(404).render('error', { title: 'Tapılmadı', msg: 'Bu tapşırıq tapılmadı.', lang: 'az' });
  const l = a.lesson_id ? lessons.lesson(a.lesson_id) : null; const mine = db.prepare(`SELECT id, status, submitted_at, source FROM hw_submissions WHERE student_id=? AND assignment_id=? ORDER BY id DESC`).all(s.id, a.id);
  const open = mine.find(m => m.status === 'submitted'); const prev = open ? Object.fromEntries(lessons.answers(open.id).map(x => [x.question_n, x.answer_text])) : {};
  res.render('student/qa', { title: a.title_az, lang: 'az', a, l, qs: lessons.questions(a.id), mine, prev, late, summaryHtml: l ? notes.render(l.summary_az || l.summary_en || '') : '', CHOOSE: a.choose_n || lessons.CHOOSE, hwEach: grades.hwEach(a.section_id), fmt: grades.fmt }); });
app.post('/telebe/tapsiriq/:id/cavablar', S, (req, res) => { const { s, a } = qaFor(req); if (!a) { flash(req, 'Tapşırıq tapılmadı.'); return res.redirect('/telebe#tapsiriqlarim'); }
  const choose = a.choose_n || lessons.CHOOSE; const filled = lessons.questions(a.id).map(q => ({ question: q.n, text: String(req.body['a' + q.n] || '').trim() })).filter(x => x.text);
  if (filled.length !== choose) { flash(req, `Zəhmət olmasa, beş sualdan düz ${choose} sual seçib cavab yazın (indi ${filled.length} cavab var).`); return res.redirect('/telebe/tapsiriq/' + a.id); }
  if (filled.some(x => x.text.length > 8000)) { flash(req, 'Cavablardan biri çox uzundur (hər cavab ən çox 8 000 simvol).'); return res.redirect('/telebe/tapsiriq/' + a.id); }
  const r = lessons.submitForm({ student: s, email: req.session.user.email, a, filled }); const h = hw.get(r.id);
  flash(req, (r.replaced ? 'Cavablarınız yeniləndi. ' : 'Təşəkkür edirik! Cavablarınız göndərildi. ') + (h.minutes_late ? `Son tarixdən sonra göndərildi, buna görə balınızdan ${h.deduction_pct}% çıxılacaq. ` : '') + 'Müəllim yoxlayandan sonra rəyi kabinetinizdə görəcəksiniz.');
  audit(req, 'qa.submit', { assignment: a.id, hw: r.id }); res.redirect('/telebe/tapsiriq/' + a.id); });
app.post('/telebe/tapsiriq/:id', S, (req, res) => { const s = me(req); const body = String(req.body.body || '').trim();
  if (db.prepare(`SELECT 1 FROM assignments WHERE id=? AND kind='qa5'`).get(req.params.id)) return res.redirect('/telebe/tapsiriq/' + req.params.id);
  const a = db.prepare(`SELECT a.*, c.code FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=a.section_id AND e.student_id=? WHERE a.id=? AND COALESCE(a.published,1)=1`).get(s?.id, req.params.id);
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
const lessonNote = l => ({ slug: 'ders-' + l.id, title: l.title_az || l.title, title_az: '', course: l.code, date: l.session_date || '', source: 'Dərs xülasəsi', body: l.summary_az || l.summary_en, html: notes.render(l.summary_az || l.summary_en),
  excerpt: String(l.summary_az || l.summary_en).replace(/[*_#>-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220) });
app.get('/telebe/xulaseler', N, (req, res) => res.render('student/notes', { title: 'Dərs xülasələri', notes: [...lessons.publishedLessonNotes().map(lessonNote), ...notes.all()], lang: 'az' }));
app.get('/telebe/xulaseler/ders-:lid', N, (req, res, next) => { const l = lessons.publishedLessonNotes().find(x => x.id === Number(req.params.lid)); if (!l) return next();
  res.render('student/note', { title: l.title_az || l.title, n: lessonNote(l), lang: 'az' }); });
app.get('/telebe/xulaseler/:slug', N, (req, res) => { const n = notes.get(req.params.slug);
  if (!n) return res.status(404).render('error', { title: 'Tapılmadı', msg: 'Bu xülasə tapılmadı.' });
  res.render('student/note', { title: n.title, n, lang: 'az' }); });

app.locals.fmt = grades.fmt;
app.use((req, res) => res.status(404).render('error', { title: 'Not found', msg: 'Page not found.' }));
app.use((err, req, res, _n) => { console.error(err); res.status(500).render('error', { title: 'Error', msg: 'Something went wrong.' }); });
if (require.main === module) {
  if (persist.enabled()) {
    if (persist.isMarked()) { persist.attach(db); console.log('Durable mode on: changes are saved to Postgres.'); }
    else console.error('DATABASE_URL is set but this database was not restored by `npm run seed`; saving is OFF to protect the saved copy. Start with `npm run seed && npm start`.');
    const bye = () => { persist.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }
  // One-time admin password reset: if BBI_ADMIN_RESET_HASH (a bcrypt hash) is set, apply it to the admin user whose email is BBI_ADMIN_EMAIL.
  // Applies only when the stored hash differs, so a restart never re-applies it. Remove the env var afterwards. The hash is never logged.
  try {
    const rh = process.env.BBI_ADMIN_RESET_HASH, ae = String(process.env.BBI_ADMIN_EMAIL || '').trim().toLowerCase();
    if (rh && /^\$2[aby]\$\d\d\$.{53}$/.test(rh) && ae) {
      const au = db.prepare("SELECT id, password_hash FROM users WHERE role='admin' AND lower(email)=?").get(ae);
      if (au && au.password_hash !== rh) { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(rh, au.id); console.log('admin password reset applied'); persist.schedule('admin-reset'); }
    }
  } catch (e) { console.error('Admin reset failed:', e.message); }
  // QR attendance: make sure this week's (and the next 4 weeks') check-in codes exist; re-check hourly so a new week's code appears on time.
  const topUp = () => { try { if (attqr.ensureWindow()) persist.schedule('qr-codes'); } catch (e) { console.error('QR codes:', e.message); } };
  // No scan = absent: once a class week is over, anyone enrolled with no mark for a session that was held gets 'absent'
  // (a teacher can still change it to excused/present on the Attendance page). Runs at boot and hourly.
  const close = () => { try { const r = attqr.closePastWeeks(); if (r.closed) persist.schedule('qr-absent'); if (r.absent) console.log('QR: week closed; ' + r.absent + ' no-scan absence(s) recorded.'); } catch (e) { console.error('QR close:', e.message); } };
  try { if (grades.ensureItems()) persist.schedule('grade-items'); } catch (e) { console.error('Grade items:', e.message); }
  topUp(); close(); setInterval(() => { topUp(); close(); }, 60 * 60e3).unref();
  app.listen(PORT, () => console.log(`Baku Bible Institute on http://localhost:${PORT} (demo=${DEMO})`));
  // One-shot SMTP smoke test (TEMPORARY; remove the env var after use). Sends ONE fixed message to the single address in BBI_SMTP_TEST_TO.
  if (process.env.BBI_SMTP_TEST_TO) (async () => {
    const v = await outbox.verify(); console.log('SMTP-TEST verify:', v.ok, v.detail);
    if (v.ok) { const r = await outbox.sendTransactional({ to: process.env.BBI_SMTP_TEST_TO, subject: 'BBI test email', text: 'This is a test from the Baku Bible Institute website. Email sending works.' }); console.log('SMTP-TEST send:', r.ok, r.error || ''); }
  })();
}
module.exports = app;
