// Anytime homework: students submit whenever they like (no deadlines).
// submitted -> drafted -> approved_by_bruce -> returned. Nothing reaches the student until Bruce
// edits and approves the English correction AND the Azeri version has been produced.
const db = require('./db'); const late = require('./late');
const STATUSES = ['submitted', 'drafted', 'approved_by_bruce', 'returned'];
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function detectLang(text) {
  const t = String(text || '');
  if (/[əƏğĞıİşŞçÇöÖüÜ]/.test(t) || /\b(və|bir|mən|biz|üçün|deyil|olan|Allah|Rəbb|İsa|Məsih)\b/i.test(t)) return 'az';
  if (/[а-яё]/i.test(t)) return 'ru';
  return 'en';
}
const cols = `id, assignment_id, due_at, max_points, late_policy, minutes_late, deduction_pct, raw_score, deduction_points, final_score, score_overridden, student_id, student_name, course_code, title, body, lang, status, translation_en, draft_en, drafted_by, drafted_at, final_en, approved_by, approved_at, return_az, returned_by, returned_at, submitted_at, updated_at`;
const get = id => db.prepare(`SELECT ${cols}, student_email FROM hw_submissions WHERE id=?`).get(id);
const all = () => db.prepare(`SELECT ${cols} FROM hw_submissions ORDER BY CASE status WHEN 'drafted' THEN 0 WHEN 'submitted' THEN 1 WHEN 'approved_by_bruce' THEN 2 ELSE 3 END, submitted_at DESC`).all();
const byStatus = s => db.prepare(`SELECT ${cols} FROM hw_submissions WHERE status=? ORDER BY submitted_at`).all(s);
const forStudent = email => db.prepare(`SELECT ${cols} FROM hw_submissions WHERE student_email=? ORDER BY submitted_at DESC`).all(String(email || '').toLowerCase());
const counts = () => Object.fromEntries(STATUSES.map(s => [s, db.prepare('SELECT COUNT(*) n FROM hw_submissions WHERE status=?').get(s).n]));
// Never blocked: late work is accepted and the deduction is computed from the assignment's policy.
function create({ student, email, course_code, title, body, assignment }) {
  const at = now(); const a = assignment || null;
  const due = a?.due_at || null; const min = due ? late.minutesLate(due, at) : 0;
  const policy = a ? (a.late_policy || late.DEFAULT_POLICY) : null; const pct = due ? late.deductionPct(min, policy) : 0;
  return db.prepare(`INSERT INTO hw_submissions (assignment_id, due_at, max_points, late_policy, minutes_late, deduction_pct, student_id, student_email, student_name, course_code, title, body, lang, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(a?.id || null, due, a?.max_points ?? null, policy, min, pct, student?.id || null, String(email || '').toLowerCase(), student?.name || 'Tələbə', course_code, title, body, detectLang(body), at, at).lastInsertRowid;
}
// Score at approval: raw points minus the late deduction; Bruce may override the final number.
function scoreFor(s, raw, override) {
  if (raw == null && override == null) return { raw_score: null, deduction_points: null, final_score: null, score_overridden: 0 };
  const r = raw == null ? null : Number(raw);
  const d = r == null || s.max_points == null ? { deduction_points: 0, final: r } : late.applyDeduction(r, s.max_points, s.deduction_pct);
  return override == null ? { raw_score: r, deduction_points: d.deduction_points, final_score: d.final, score_overridden: 0 } : { raw_score: r, deduction_points: d.deduction_points, final_score: Number(override), score_overridden: 1 };
}
// (b) English translation + English correction draft. Allowed only before Bruce approves.
function setDraft(id, { translation_en, draft_en, by }) {
  const r = db.prepare(`UPDATE hw_submissions SET translation_en=?, draft_en=?, drafted_by=?, drafted_at=?, updated_at=?, status='drafted' WHERE id=? AND status IN ('submitted','drafted')`)
    .run(translation_en || null, draft_en, by || 'assistant', now(), now(), id);
  return r.changes === 1;
}
function saveEdit(id, final_en) {
  return db.prepare(`UPDATE hw_submissions SET final_en=?, updated_at=? WHERE id=? AND status IN ('submitted','drafted','approved_by_bruce')`).run(final_en, now(), id).changes === 1;
}
// Bruce's explicit approval of his edited English final.
function approve(id, final_en, by, score) {
  const sc = score || {};
  return db.prepare(`UPDATE hw_submissions SET final_en=?, raw_score=?, deduction_points=?, final_score=?, score_overridden=?, approved_by=?, approved_at=?, updated_at=?, status='approved_by_bruce' WHERE id=? AND status IN ('submitted','drafted','approved_by_bruce')`)
    .run(final_en, sc.raw_score ?? null, sc.deduction_points ?? null, sc.final_score ?? null, sc.score_overridden || 0, by, now(), now(), id).changes === 1;
}
function unapprove(id) {
  return db.prepare(`UPDATE hw_submissions SET status=CASE WHEN draft_en IS NULL THEN 'submitted' ELSE 'drafted' END, approved_by=NULL, approved_at=NULL, updated_at=? WHERE id=? AND status='approved_by_bruce'`).run(now(), id).changes === 1;
}
// (d) Azeri return text. Refused unless Bruce has approved.
// The grade is written to the gradebook only now, so the student never sees it before the Azeri feedback.
function setReturn(id, return_az, by) {
  return db.transaction(() => {
    const ok = db.prepare(`UPDATE hw_submissions SET return_az=?, returned_by=?, returned_at=?, updated_at=?, status='returned' WHERE id=? AND status='approved_by_bruce' AND final_en IS NOT NULL AND approved_at IS NOT NULL`)
      .run(return_az, by || 'assistant', now(), now(), id).changes === 1;
    if (!ok) return false;
    const s = get(id); const a = s.assignment_id ? db.prepare('SELECT grade_item_id FROM assignments WHERE id=?').get(s.assignment_id) : null;
    if (a?.grade_item_id && s.student_id && s.final_score != null) {
      const note = s.minutes_late ? `Ev tapşırığı · gecikmə −${s.deduction_pct}%` : 'Ev tapşırığı';
      db.prepare(`INSERT INTO grades (grade_item_id, student_id, points, comment, source) VALUES (?,?,?,?, 'homework') ON CONFLICT(grade_item_id, student_id) DO UPDATE SET points=excluded.points, comment=excluded.comment, source='homework', updated_at=CURRENT_TIMESTAMP`)
        .run(a.grade_item_id, s.student_id, s.final_score, note);
    }
    return true;
  })();
}
const remove = id => db.prepare('DELETE FROM hw_submissions WHERE id=?').run(id).changes === 1;

// Optional built-in engine: only when OPENAI_API_KEY is set on the server. Otherwise the
// scheduled assistant does the same work through the token-protected /api/homework endpoints.
const llmEnabled = () => !!process.env.OPENAI_API_KEY;
async function chat(system, user) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  const j = await r.json(); const t = j.choices?.[0]?.message?.content; if (!t) throw new Error('no content'); return t.trim();
}
async function autoDraft(id) {
  if (!llmEnabled()) return false; const s = get(id); if (!s || s.status !== 'submitted') return false;
  try {
    const translation = s.lang === 'en' ? null : await chat('Translate this Bible-school homework into clear English. Output only the translation.', s.body);
    const draft = await chat('You are a kind teaching assistant at the Baku Bible Institute. Write a short, warm, personal correction of this homework in English for Pastor Bruce Wright to edit: thank the student, note strengths, give concrete corrections (content, Scripture use, grammar), and one next step. Plain text.',
      `Class: ${s.course_code}\nTitle: ${s.title}\nStudent: ${s.student_name}\n\nHomework (English):\n${translation || s.body}`);
    return setDraft(id, { translation_en: translation, draft_en: draft, by: 'Homework Helper (AI)' });
  } catch (e) { console.error('autoDraft failed for', id); return false; }
}
async function autoReturn(id) {
  if (!llmEnabled()) return false; const s = get(id); if (!s || s.status !== 'approved_by_bruce') return false;
  try { const az = await chat('Translate this teacher feedback into warm, simple Azerbaijani (Latin script). Keep the meaning exactly; do not add anything. Output only the translation.', s.final_en);
    return setReturn(id, az, 'Homework Helper (AI)'); } catch { console.error('autoReturn failed for', id); return false; }
}
module.exports = { scoreFor, STATUSES, detectLang, get, all, byStatus, forStudent, counts, create, setDraft, saveEdit, approve, unapprove, setReturn, remove, llmEnabled, autoDraft, autoReturn };
