// Class-session lessons → five questions → students answer three → per-answer review → overview for Bruce.
// The site only stores and queues work. Summaries, questions and reviews are written by Bruce's scheduled
// assistant through the token API (docs/HOMEWORK_API.md) — no paid AI service is called from here.
// Nothing is sent to students automatically: assignments stay DRAFT until Bruce publishes them, and
// feedback still goes through the existing approve → Azeri return flow.
const db = require('./db'); const hw = require('./homework');

db.exec(`CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL, title_az TEXT, session_date TEXT, source TEXT NOT NULL DEFAULT 'paste', source_ref TEXT, source_text TEXT, note_slug TEXT,
  summary_en TEXT, summary_az TEXT, outline TEXT, status TEXT NOT NULL DEFAULT 'needs_summary' CHECK(status IN ('needs_summary','needs_questions','draft_ready','published')),
  summary_by TEXT, questions_by TEXT, show_in_notes INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assignment_questions (id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, n INTEGER NOT NULL, text_en TEXT, text_az TEXT, UNIQUE(assignment_id, n));
CREATE TABLE IF NOT EXISTS hw_answers (id INTEGER PRIMARY KEY, hw_submission_id INTEGER NOT NULL REFERENCES hw_submissions(id) ON DELETE CASCADE, question_n INTEGER NOT NULL,
  answer_text TEXT NOT NULL, answer_en TEXT, correction_en TEXT, content_en TEXT, alignment TEXT CHECK(alignment IN ('strong','partial','weak')), score INTEGER CHECK(score BETWEEN 1 AND 5), points REAL,
  UNIQUE(hw_submission_id, question_n));`);
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('assignments', 'lesson_id', 'INTEGER'); addCol('assignments', 'kind', 'TEXT'); addCol('assignments', 'choose_n', 'INTEGER'); addCol('assignments', 'published', 'INTEGER NOT NULL DEFAULT 1');
for (const [c, d] of [['split_by', 'TEXT'], ['review_note', 'TEXT'], ['suggested_points', 'REAL'], ['reviewed_by', 'TEXT'], ['reviewed_at', 'TEXT'], ['reported_at', 'TEXT'], ['answer_flag', 'TEXT']]) addCol('hw_submissions', c, d);

const N_Q = 5, CHOOSE = 3, MAX_POINTS = 30;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const INSTRUCTIONS_AZ = 'Beş sualdan üçünü seçin və öz sözlərinizlə cavab verin. Qısa və aydın cavablar xoşdur. Cavabları saytda, WhatsApp-da və ya e-poçtla göndərə bilərsiniz — hər cavabın əvvəlində sualın nömrəsini yazın (məsələn: “1)”, “3)”, “5)”).';
const ALIGN = ['strong', 'partial', 'weak'];

// ---- lessons ----
const lessonQ = `SELECT l.*, c.code, c.title course, (SELECT id FROM assignments a WHERE a.lesson_id=l.id ORDER BY a.id DESC LIMIT 1) assignment_id FROM lessons l JOIN sections sec ON sec.id=l.section_id JOIN courses c ON c.id=sec.course_id`;
const lesson = id => db.prepare(lessonQ + ' WHERE l.id=?').get(id);
const lessons = status => db.prepare(lessonQ + (status ? ' WHERE l.status=?' : '') + ' ORDER BY COALESCE(l.session_date, l.created_at) DESC, l.id DESC').all(...(status ? [status] : []));
const sectionByCode = code => db.prepare(`SELECT sec.id FROM sections sec JOIN courses c ON c.id=sec.course_id WHERE upper(c.code)=upper(?) ORDER BY sec.id DESC LIMIT 1`).get(String(code || '').trim());
function createLesson({ section_id, title, title_az, session_date, source, source_ref, source_text, note_slug, created_by }) {
  if (source_ref) { const ex = db.prepare('SELECT id FROM lessons WHERE section_id=? AND source=? AND source_ref=?').get(section_id, source || 'paste', source_ref); if (ex) return { id: ex.id, existed: true }; }
  const id = db.prepare('INSERT INTO lessons (section_id, title, title_az, session_date, source, source_ref, source_text, note_slug, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(section_id, String(title).slice(0, 200), title_az ? String(title_az).slice(0, 200) : null, session_date || null, ['pocket', 'paste', 'note'].includes(source) ? source : 'paste', source_ref ? String(source_ref).slice(0, 300) : null,
      source_text ? String(source_text).slice(0, 100000) : null, note_slug || null, created_by || null).lastInsertRowid;
  return { id, existed: false };
}
function setSummary(id, { summary_en, summary_az, outline, title, title_az, by }) {
  const l = lesson(id); if (!l) return false;
  db.prepare(`UPDATE lessons SET summary_en=?, summary_az=?, outline=?, title=COALESCE(?, title), title_az=COALESCE(?, title_az), summary_by=?, updated_at=?,
    status=CASE WHEN status='needs_summary' THEN 'needs_questions' ELSE status END WHERE id=?`)
    .run(summary_en, summary_az || null, outline || null, title || null, title_az || null, by || 'assistant', now(), id);
  return true;
}
const questions = aid => db.prepare('SELECT n, text_en, text_az FROM assignment_questions WHERE assignment_id=? ORDER BY n').all(aid);
const assignment = aid => db.prepare(`SELECT a.*, c.code, c.title course FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id WHERE a.id=?`).get(aid);
const isQA = a => !!a && a.kind === 'qa5';
// Write the five questions; creates (or updates) the lesson's DRAFT assignment. Refused once students can see it.
function setQuestions(id, qs, { by, instructions_az } = {}) {
  const l = lesson(id); if (!l) return { error: 'not found', code: 404 };
  if (!Array.isArray(qs) || qs.length !== N_Q || qs.some(q => !String(q?.en || '').trim() || !String(q?.az || '').trim())) return { error: `exactly ${N_Q} questions, each with en and az`, code: 400 };
  let a = l.assignment_id && assignment(l.assignment_id);
  if (a && a.published) return { error: 'refused: already published to students; edit it on the lesson page instead', code: 409 };
  return db.transaction(() => {
    if (!a) { const aid = db.prepare(`INSERT INTO assignments (section_id, title_az, instructions_az, max_points, kind, choose_n, published, lesson_id) VALUES (?,?,?,?, 'qa5', ?, 0, ?)`)
      .run(l.section_id, l.title_az || l.title, instructions_az || INSTRUCTIONS_AZ, MAX_POINTS, CHOOSE, l.id).lastInsertRowid; a = assignment(aid); }
    else if (instructions_az) db.prepare('UPDATE assignments SET instructions_az=? WHERE id=?').run(instructions_az, a.id);
    const up = db.prepare('INSERT INTO assignment_questions (assignment_id, n, text_en, text_az) VALUES (?,?,?,?) ON CONFLICT(assignment_id, n) DO UPDATE SET text_en=excluded.text_en, text_az=excluded.text_az');
    qs.forEach((q, i) => up.run(a.id, i + 1, String(q.en).trim().slice(0, 3000), String(q.az).trim().slice(0, 3000)));
    db.prepare(`UPDATE lessons SET questions_by=?, updated_at=?, status=CASE WHEN status='published' THEN status ELSE 'draft_ready' END WHERE id=?`).run(by || 'assistant', now(), l.id);
    return { ok: true, assignment_id: a.id };
  })();
}

// ---- splitting free text (WhatsApp / email / pasted) into numbered answers ----
// Recognises a number 1–5 at the start of a line: "1)", "1.", "1:", "1 -", "#1", "S1", "Sual 1", "1-ci sual", "Question 1", "Q1", "Cavab 1".
const MARK = /^\s*(?:\*\*)?\s*(?:(?:sual|question|cavab|answer|q|s)\s*(?:№|no\.?|#)?\s*([1-5])(?![0-9])|#\s*([1-5])(?![0-9])|([1-5])\s*(?:-?\s*(?:ci|cı|cu|cü)\s*(?:sual|cavab)?|[.):\-–—]|\s+(?:sual|cavab)))\s*(?:\*\*)?\s*[.):\-–—]?\s*/i;
function splitAnswers(text) {
  const parts = []; let cur = null; const pre = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(MARK);
    if (m) { const n = Number(m[1] || m[2] || m[3]); cur = { n, lines: [line.slice(m[0].length)] }; parts.push(cur); }
    else if (cur) cur.lines.push(line); else pre.push(line);
  }
  const byN = new Map(); for (const p of parts) { const t = p.lines.join('\n').trim(); if (!t) continue; byN.set(p.n, byN.has(p.n) ? byN.get(p.n) + '\n' + t : t); }
  if (!byN.size) return null;
  return { answers: [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, t]) => ({ question: n, text: t })), preamble: pre.join('\n').trim() };
}
const answers = hid => db.prepare('SELECT * FROM hw_answers WHERE hw_submission_id=? ORDER BY question_n').all(hid);
function flagFor(list, choose = CHOOSE) { const n = list.length; return n === choose ? null : n > choose ? `answered ${n} questions (asked for ${choose})` : `answered ${n} of ${choose} questions`; }
function saveSplit(hid, list, by) {
  db.transaction(() => { db.prepare('DELETE FROM hw_answers WHERE hw_submission_id=?').run(hid);
    const ins = db.prepare('INSERT INTO hw_answers (hw_submission_id, question_n, answer_text) VALUES (?,?,?)'); for (const a of list) ins.run(hid, a.question, String(a.text).slice(0, 20000));
    db.prepare('UPDATE hw_submissions SET split_by=?, answer_flag=? WHERE id=?').run(by, list.length ? flagFor(list) : 'answers not numbered — the assistant will split them', hid); })();
}
// Called whenever a submission is filed or its assignment changes. Only acts on five-question assignments.
function onFiled(hid) {
  const s = hw.get(hid); if (!s || !s.assignment_id) return false; const a = assignment(s.assignment_id); if (!isQA(a)) return false;
  if (db.prepare('SELECT split_by FROM hw_submissions WHERE id=?').get(hid).split_by === 'form') return true;
  const sp = splitAnswers(s.body); saveSplit(hid, sp ? sp.answers : [], sp ? 'parser' : null); return true;
}
// Several WhatsApp messages/emails for the same five-question assignment are merged into one open submission (not yet reviewed).
function findOpenInbound(studentId, assignmentId) {
  if (!studentId || !assignmentId || !isQA(assignment(assignmentId))) return null;
  return db.prepare(`SELECT id FROM hw_submissions WHERE student_id=? AND assignment_id=? AND status='submitted' AND reviewed_at IS NULL AND source IN ('whatsapp','email') AND submitted_at >= datetime('now','-3 days') ORDER BY id DESC LIMIT 1`).get(studentId, assignmentId);
}
function appendInbound(hid, text, mediaNote) {
  const s = hw.get(hid); const body = (s.body + '\n\n' + String(text || '').trim()).trim().slice(0, 20000);
  db.prepare('UPDATE hw_submissions SET body=?, lang=?, media_note=CASE WHEN ? IS NULL THEN media_note ELSE TRIM(COALESCE(media_note,\'\') || char(10) || ?) END, updated_at=? WHERE id=?').run(body, hw.detectLang(body), mediaNote || null, mediaNote || null, now(), hid);
  onFiled(hid); return hid;
}
// Web form: one textarea per question; exactly CHOOSE answers. Replaces an unreviewed earlier web submission.
function submitForm({ student, email, a, filled }) {
  const body = filled.map(x => `Sual ${x.question}:\n${x.text}`).join('\n\n');
  const prev = db.prepare(`SELECT id FROM hw_submissions WHERE student_id=? AND assignment_id=? AND status='submitted' AND reviewed_at IS NULL AND source='web' ORDER BY id DESC LIMIT 1`).get(student.id, a.id);
  let id;
  if (prev) { id = prev.id; db.prepare('UPDATE hw_submissions SET body=?, lang=?, updated_at=? WHERE id=?').run(body, hw.detectLang(body), now(), id); }
  else id = hw.create({ student, email, course_code: a.code, title: a.title_az, body, assignment: a, source: 'web' });
  saveSplit(id, filled, 'form'); return { id, replaced: !!prev };
}

// ---- review (written by the assistant) ----
function review(hid, b) {
  const s = hw.get(hid); if (!s) return { error: 'not found', code: 404 };
  const a = s.assignment_id && assignment(s.assignment_id); if (!isQA(a)) return { error: 'not a five-question assignment', code: 400 };
  if (!['submitted', 'drafted'].includes(s.status)) return { error: 'refused: Bruce has already approved or returned this', code: 409 };
  const list = Array.isArray(b.answers) ? b.answers : []; const ppq = (a.max_points || MAX_POINTS) / (a.choose_n || CHOOSE);
  if (!list.length || list.length > N_Q) return { error: 'answers: 1–5 items required', code: 400 };
  const seen = new Set();
  for (const x of list) {
    const n = Number(x.question); if (!(n >= 1 && n <= N_Q) || seen.has(n)) return { error: 'each answer needs a unique question number 1–5', code: 400 }; seen.add(n);
    if (!String(x.answer_text || '').trim()) return { error: `answer ${n}: answer_text (the student's own words for that question) is required`, code: 400 };
    if (s.lang !== 'en' && !String(x.answer_en || '').trim()) return { error: `answer ${n}: answer_en (English translation) is required for non-English work`, code: 400 };
    if (!String(x.correction_en || '').trim() || !String(x.content_en || '').trim()) return { error: `answer ${n}: correction_en and content_en are required`, code: 400 };
    if (!ALIGN.includes(String(x.alignment || '').toLowerCase())) return { error: `answer ${n}: alignment must be strong, partial or weak`, code: 400 };
    if (!(Number.isInteger(Number(x.score)) && x.score >= 1 && x.score <= 5)) return { error: `answer ${n}: score must be an integer 1–5`, code: 400 };
    if (x.points != null && !(Number(x.points) >= 0 && Number(x.points) <= ppq)) return { error: `answer ${n}: points must be 0–${ppq}`, code: 400 };
  }
  const draft = String(b.draft_en || '').trim() || composeDraft(s, a, list);
  return db.transaction(() => {
    db.prepare('DELETE FROM hw_answers WHERE hw_submission_id=?').run(hid);
    const ins = db.prepare('INSERT INTO hw_answers (hw_submission_id, question_n, answer_text, answer_en, correction_en, content_en, alignment, score, points) VALUES (?,?,?,?,?,?,?,?,?)');
    let total = 0; for (const x of list.sort((p, q) => p.question - q.question)) { const pts = x.points != null ? Number(x.points) : Math.round(ppq * Number(x.score) / 5 * 2) / 2; total += pts;
      ins.run(hid, Number(x.question), String(x.answer_text).trim().slice(0, 20000), x.answer_en ? String(x.answer_en).trim().slice(0, 20000) : null, String(x.correction_en).trim().slice(0, 8000), String(x.content_en).trim().slice(0, 8000), String(x.alignment).toLowerCase(), Number(x.score), pts); }
    const by = String(b.by || 'assistant').slice(0, 60);
    db.prepare(`UPDATE hw_submissions SET review_note=?, suggested_points=?, reviewed_by=?, reviewed_at=?, reported_at=NULL, split_by=COALESCE(split_by,'assistant'), answer_flag=? WHERE id=?`)
      .run(String(b.note_en || '').trim().slice(0, 2000) || null, Math.min(total, a.max_points || MAX_POINTS), by, now(), flagFor(list, a.choose_n || CHOOSE), hid);
    hw.setDraft(hid, { translation_en: String(b.translation_en || '').trim() || (s.lang !== 'en' ? list.map(x => `Question ${x.question}:\n${x.answer_en}`).join('\n\n') : null), draft_en: draft, by });
    return { ok: true, id: hid, status: 'drafted', suggested_points: total };
  })();
}
function composeDraft(s, a, list) {
  const first = String(s.student_name || '').split(' ')[0];
  return [`Dear ${first},`, '', 'Thank you for your answers.', '', ...list.flatMap(x => [`Question ${x.question}: ${x.content_en}`, `Language: ${x.correction_en}`, '']), 'Thank you, and God bless you.', 'Pastor Bruce Wright'].join('\n');
}

// ---- overview for Bruce ----
const LBL = { strong: 'Strong', partial: 'Partial', weak: 'Weak' };
function overview(hid, base = '') {
  const s = hw.get(hid); if (!s || !s.assignment_id) return null; const a = assignment(s.assignment_id); if (!isQA(a)) return null;
  const meta = db.prepare('SELECT review_note, suggested_points, reviewed_by, reviewed_at, reported_at, answer_flag, split_by FROM hw_submissions WHERE id=?').get(hid);
  const qs = questions(a.id); const ans = answers(hid); const chosen = ans.map(x => x.question_n);
  const max = a.max_points || MAX_POINTS; const pct = meta.suggested_points != null ? Math.round(100 * meta.suggested_points / max) : null;
  const o = { id: s.id, assignment_id: a.id, lesson_id: a.lesson_id, course_code: a.code, course: a.course, assignment_title: a.title_az, student_first_name: String(s.student_name || '').split(' ')[0],
    source: s.source, lang: s.lang, status: s.status, submitted_baku: require('./late').fmtBaku(s.submitted_at), questions_chosen: chosen, questions_not_answered: qs.map(q => q.n).filter(n => !chosen.includes(n)), flag: meta.answer_flag,
    answers: ans.map(x => ({ question: x.question_n, question_en: qs.find(q => q.n === x.question_n)?.text_en || null, answer_text: x.answer_text, answer_en: x.answer_en, correction_en: x.correction_en, content_en: x.content_en, alignment: x.alignment, score: x.score, points: x.points })),
    suggested_points: meta.suggested_points, max_points: max, suggested_pct: pct, note_en: meta.review_note, reviewed_by: meta.reviewed_by, reviewed_at: meta.reviewed_at, reported_at: meta.reported_at,
    admin_url: base + '/admin/homework/anytime/' + s.id, assignment_overview_url: base + '/admin/homework/assignment/' + a.id };
  o.message_md = [`**${o.course_code} ${o.course} — ${o.assignment_title}**`, `Student: ${o.student_first_name} · arrived by ${o.source} · ${o.lang === 'az' ? 'Azeri' : o.lang === 'en' ? 'English' : o.lang}`,
    `Questions chosen: ${chosen.join(', ') || '—'} (not answered: ${o.questions_not_answered.join(', ') || '—'})${o.flag ? ' · ⚠ ' + o.flag : ''}`,
    `Suggested score: ${o.suggested_points ?? '—'} / ${max}${pct != null ? ` (${pct}%)` : ''} — ${o.answers.map(x => `Q${x.question}: ${x.points ?? '—'}`).join('; ')}`, '',
    ...o.answers.flatMap(x => [`${x.question}. ${LBL[x.alignment] || '—'} ${x.score ?? '—'}/5 — ${x.content_en || ''}`]), '', o.note_en ? `Note: ${o.note_en}` : '', `Review and approve: ${o.admin_url}`].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
  return o;
}
const needsReview = () => db.prepare(`SELECT h.id FROM hw_submissions h JOIN assignments a ON a.id=h.assignment_id WHERE a.kind='qa5' AND h.status='submitted' ORDER BY h.submitted_at`).all().map(r => r.id);
const needsReport = () => db.prepare(`SELECT h.id FROM hw_submissions h JOIN assignments a ON a.id=h.assignment_id WHERE a.kind='qa5' AND h.reviewed_at IS NOT NULL AND h.reported_at IS NULL AND h.status='drafted' ORDER BY h.reviewed_at`).all().map(r => r.id);
const markReported = id => db.prepare('UPDATE hw_submissions SET reported_at=? WHERE id=? AND reviewed_at IS NOT NULL').run(now(), id).changes === 1;
const submissionsFor = aid => db.prepare('SELECT id FROM hw_submissions WHERE assignment_id=? ORDER BY student_name, id DESC').all(aid).map(r => r.id);

// Short WhatsApp messages count as homework when the student has an open five-question assignment and the text
// is numbered ("1) …") or continues answers already started in the last 3 days.
function looksLikeAnswers(studentId, text) {
  if (!String(text || '').trim()) return false; const inbound = require('./inbound');
  const open = inbound.openAssignmentsFor(studentId).filter(a => a.kind === 'qa5'); if (!open.length) return false;
  return !!splitAnswers(text) || open.some(a => findOpenInbound(studentId, a.id));
}
// Read helpers for the student portal / class notes
const publishedLessonNotes = () => db.prepare(`SELECT l.*, c.code FROM lessons l JOIN sections sec ON sec.id=l.section_id JOIN courses c ON c.id=sec.course_id JOIN assignments a ON a.lesson_id=l.id
  WHERE a.published=1 AND l.show_in_notes=1 AND COALESCE(l.summary_az, l.summary_en) IS NOT NULL GROUP BY l.id ORDER BY l.session_date DESC`).all();

module.exports = { N_Q, CHOOSE, MAX_POINTS, INSTRUCTIONS_AZ, ALIGN, lesson, lessons, sectionByCode, createLesson, setSummary, questions, assignment, isQA, setQuestions, splitAnswers, answers, saveSplit, onFiled,
  findOpenInbound, appendInbound, submitForm, looksLikeAnswers, review, overview, needsReview, needsReport, markReported, submissionsFor, publishedLessonNotes };
