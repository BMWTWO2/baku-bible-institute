// Homework arriving by WhatsApp or email. Never sends a reply or WhatsApp message.
const path = require('path'); const fs = require('fs');
const db = require('./db'); const hw = require('./homework');

const HW_KEYS = /tapşırığ|tapsirig|tapşırıq|tapsiriq|homework|\bev tapş|\bev taps|esse|essay/i;

function looksLikeHomework({ text, media } = {}) {
  const t = String(text || '');
  if (HW_KEYS.test(t)) return true;
  if (t.trim().length > 200) return true;
  return (media || []).some(m => /^(image|document)$/i.test(m.type || ''));
}

function parseFrom(from) {
  const s = String(from || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function htmlToText(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function assignmentsFor(studentId) {
  if (!studentId) return [];
  return db.prepare(`SELECT a.*, c.code, c.title course FROM assignments a JOIN sections sec ON sec.id=a.section_id JOIN courses c ON c.id=sec.course_id
    JOIN enrollments e ON e.section_id=sec.id AND e.student_id=? ORDER BY a.due_at IS NULL, a.due_at, a.id`).all(studentId);
}

function openAssignmentsFor(studentId) {
  const now = new Date().toISOString();
  return assignmentsFor(studentId).filter(a => !a.due_at || a.due_at >= now);
}

function matchAssignment(studentId, text) {
  if (!studentId) return null;
  const hay = String(text || '').toLocaleLowerCase('az');
  const all = assignmentsFor(studentId);
  const named = hay.trim() ? all.filter(a => {
    const title = String(a.title_az || '').toLocaleLowerCase('az');
    const code = String(a.code || '').toLocaleLowerCase('az');
    return (title.length >= 4 && hay.includes(title)) || (code && hay.includes(code));
  }) : [];
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  const open = openAssignmentsFor(studentId);
  return open.length === 1 ? open[0] : null;
}

function guessCourse(studentId, text, assignment) {
  if (assignment?.code) return assignment.code;
  const m = String(text || '').match(/\b([A-Za-z]{2,4})\s?(\d{3})\b/);
  if (m) { const code = (m[1] + ' ' + m[2]).toUpperCase(); if (db.prepare('SELECT 1 FROM courses WHERE code=?').get(code)) return code; }
  const enr = studentId ? db.prepare(`SELECT c.code FROM enrollments e JOIN sections sec ON sec.id=e.section_id JOIN courses c ON c.id=sec.course_id WHERE e.student_id=? ORDER BY c.code`).all(studentId) : [];
  return enr.length === 1 ? enr[0].code : '—';
}

function guessTitle(text, subject, assignment) {
  if (assignment?.title_az) return assignment.title_az;
  const sub = String(subject || '').trim().replace(/^re:\s*/i, '').trim();
  if (sub) return sub.slice(0, 200);
  const line = String(text || '').trim().split(/\n/)[0].trim();
  if (line && line.length <= 120) return line.slice(0, 200);
  return 'Homework';
}

function formatMediaNote(media) {
  if (!media || !media.length) return null;
  return media.map(m => {
    const bits = [m.type || 'file'];
    if (m.filename) bits.push(m.filename);
    if (m.mime) bits.push(m.mime);
    if (m.id) bits.push('id ' + m.id);
    if (m.size) bits.push(m.size + ' bytes');
    if (m.saved) bits.push('saved ' + m.saved);
    else if (m.downloadError) bits.push('(download failed)');
    else bits.push('(reference only)');
    if (m.caption) bits.push('caption: ' + String(m.caption).slice(0, 120));
    return bits.join(' · ');
  }).join('\n');
}

async function downloadWhatsAppMedia(media) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  if (!token || !media || !media.length) return { media: media || [], downloaded: false };
  const dir = path.join(__dirname, '..', 'data', 'media');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const m of media) {
    const item = { ...m };
    if (!m.id) { out.push(item); continue; }
    try {
      const metaRes = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(m.id), { headers: { authorization: 'Bearer ' + token } });
      if (!metaRes.ok) throw new Error('meta ' + metaRes.status);
      const meta = await metaRes.json();
      if (!meta.url) throw new Error('no url');
      const bin = await fetch(meta.url, { headers: { authorization: 'Bearer ' + token } });
      if (!bin.ok) throw new Error('file ' + bin.status);
      const ext = (m.filename && path.extname(m.filename)) || { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[m.mime || meta.mime_type] || '';
      const fname = ('wa-' + String(m.id).replace(/[^\w.-]/g, '') + ext).slice(0, 120);
      fs.writeFileSync(path.join(dir, fname), Buffer.from(await bin.arrayBuffer()));
      item.saved = 'data/media/' + fname;
      item.mime = item.mime || meta.mime_type;
    } catch { item.downloadError = true; }
    out.push(item);
  }
  return { media: out, downloaded: true };
}

async function attachWhatsAppMedia(hwId, media) {
  const { media: got } = await downloadWhatsAppMedia(media);
  const note = formatMediaNote(got);
  if (note) hw.setMediaNote(hwId, note);
  return note;
}

function matchStudentByEmail(email) {
  const e = parseFrom(email);
  if (!e || !e.includes('@')) return null;
  return db.prepare(`SELECT s.*, u.email AS user_email FROM students s LEFT JOIN users u ON u.id=s.user_id
    WHERE s.status='active' AND (lower(COALESCE(s.email,''))=? OR lower(COALESCE(u.email,''))=?) LIMIT 1`).get(e, e);
}

function fileHomework({ student, email, source, text, subject, mediaNote, assignment, assignmentOverride, source_ref }) {
  const a = assignmentOverride || assignment || matchAssignment(student?.id, [subject, text].filter(Boolean).join('\n'));
  const body = String(text || '').trim() || (mediaNote ? '[See attached media]\n' + mediaNote : '');
  if (!body) return null;
  const course_code = guessCourse(student?.id, [subject, text].filter(Boolean).join('\n'), a);
  const title = guessTitle(text, subject, a);
  const id = hw.create({
    student, email: email || student?.email || student?.user_email, course_code, title,
    body: body.slice(0, 20000), assignment: a, source: source || 'web', media_note: mediaNote || null, source_ref: source_ref || null
  });
  return { id, assignment_id: a?.id || null, needs_assignment: !a };
}

function recordUnmatched({ channel, sender, subject, body, raw }) {
  return db.prepare(`INSERT INTO inbound_unmatched (channel, sender, subject, body, raw_json) VALUES (?,?,?,?,?)`)
    .run(channel, String(sender || '').slice(0, 300), subject ? String(subject).slice(0, 300) : null, body ? String(body).slice(0, 20000) : null, raw ? String(JSON.stringify(raw)).slice(0, 20000) : null).lastInsertRowid;
}

const unmatchedList = (status = 'pending') => db.prepare(`SELECT * FROM inbound_unmatched ${status && status !== 'all' ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 200`).all(...(status && status !== 'all' ? [status] : []));
const unmatchedGet = id => db.prepare('SELECT * FROM inbound_unmatched WHERE id=?').get(id);
const unmatchedCount = () => db.prepare(`SELECT COUNT(*) n FROM inbound_unmatched WHERE status='pending'`).get().n;
function dismissUnmatched(id) { return db.prepare(`UPDATE inbound_unmatched SET status='dismissed' WHERE id=? AND status='pending'`).run(id).changes === 1; }
function markUnmatchedFiled(id, studentId, hwId) { return db.prepare(`UPDATE inbound_unmatched SET status='filed', student_id=?, hw_submission_id=? WHERE id=?`).run(studentId, hwId, id).changes === 1; }

const sourceLabel = s => ({ web: 'Web', whatsapp: 'WhatsApp', email: 'Email' }[s] || s || 'Web');

module.exports = {
  looksLikeHomework, parseFrom, htmlToText, assignmentsFor, openAssignmentsFor, matchAssignment,
  formatMediaNote, downloadWhatsAppMedia, attachWhatsAppMedia, matchStudentByEmail, fileHomework,
  recordUnmatched, unmatchedList, unmatchedGet, unmatchedCount, dismissUnmatched, markUnmatchedFiled, sourceLabel
};
