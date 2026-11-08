// WhatsApp intake: normalize payloads, match students, suggest (never auto-apply) actions.
const db = require('./db');
const digits = s => String(s || '').replace(/\D/g, '');
function matchStudent(phone) {
  const d = digits(phone); if (!d) return null;
  const rows = db.prepare('SELECT id, name, whatsapp_phone FROM students WHERE whatsapp_phone IS NOT NULL').all();
  return rows.find(r => { const p = digits(r.whatsapp_phone); return p && (p === d || p.endsWith(d.slice(-9)) && d.length >= 9); }) || null;
}
// Accept Meta Cloud API payloads or simple {from,name,text}
function normalize(body) {
  const out = [];
  if (body && body.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
    for (const e of body.entry) for (const ch of (e.changes || [])) {
      const v = ch.value || {}; const contacts = v.contacts || [];
      for (const m of (v.messages || [])) {
        const c = contacts.find(x => x.wa_id === m.from) || contacts[0] || {};
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.image?.caption || m.document?.caption || `[${m.type} message]`;
        out.push({ wa_message_id: m.id, from: m.from, name: c.profile?.name || null, text, ts: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(), raw: m });
      }
    }
  } else if (body && (body.from || body.text)) {
    out.push({ wa_message_id: body.id || null, from: String(body.from || ''), name: body.name || null, text: String(body.text || ''), ts: body.timestamp || new Date().toISOString(), raw: body });
  }
  return out;
}
function suggest(text, student) {
  if (!student && text) { /* unknown sender */ }
  const t = (text || '').toLocaleLowerCase('az');
  const num = (text.match(/(\d{1,3})\s*(?:\/\s*\d+|bal|points?|pts|%)/i) || text.match(/(?:qiymət|grade|score)\D{0,25}?(\d{1,3})(?!\d)(?!\s*-)/i) || [])[1];
  const has = (...w) => w.some(x => t.includes(x));
  const course = ((text || '').match(/\b([A-Za-z]{2,4})\s?(\d{3})\b/) || []).slice(1, 3).join(' ').toUpperCase() || null;
  if (!student || student.isTeacher) { // a teacher may name a student in the message
    const first = db.prepare('SELECT id, name FROM students').all().find(s => t.includes(s.name.split(' ')[0].toLocaleLowerCase('az')));
    if (first) student = first; else if (student?.isTeacher) student = null; }
  if (has('ev tapşırığ', 'homework', 'tapşırıq', 'esse', 'essay')) return { action: 'file_homework', payload: { student_id: student?.id || null, course: course, body: text } };
  if (has('qiymət', 'grade', 'bal ', ' bal', 'score')) return { action: 'record_grade', payload: { student_id: student?.id || null, points: num ? Number(num) : null, course } };
  if (has('gəlmə', 'gələ bilmə', 'absent', 'xəstə', 'sick', 'iştirak', 'dərsdə', 'gecik', 'late', 'üzrlü', 'excuse')) {
    let status = 'absent'; if (has('xəstə', 'sick', 'üzrlü', 'excuse', 'icazə')) status = 'excused'; else if (has('gecik', 'late')) status = 'late'; else if (has('iştirak etdim', 'buradayam', 'present')) status = 'present';
    return { action: 'mark_attendance', payload: { student_id: student?.id || null, status, course, note: text.slice(0, 200) } };
  }
  if ((!student || student.isTeacher) && !has('xəstə')) return { action: 'create_student', payload: {} };
  if (has('qeydiyyat', 'yeni tələbə', 'register', 'enroll', 'apply', 'müraciət')) return { action: 'create_student', payload: {} };
  return { action: 'none', payload: {} };
}
function ingest(body, { demo = false } = {}) {
  const items = normalize(body); const saved = [];
  const ins = db.prepare(`INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, from_number, contact_name, body, received_at, raw_json, student_id, suggested_action, suggested_payload, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const m of items) {
    const st = matchStudent(m.from);
    const teacher = !st && db.prepare('SELECT id FROM teachers').all().length && db.prepare('SELECT id, whatsapp_phone FROM teachers').all().find(x => digits(x.whatsapp_phone) === digits(m.from));
    const s = suggest(m.text, teacher ? { isTeacher: true } : st);
    if (s.action === 'create_student') Object.assign(s.payload, { name: m.name || '', whatsapp_phone: '+' + digits(m.from) });
    const r = ins.run(m.wa_message_id, '+' + digits(m.from), m.name, m.text, m.ts, JSON.stringify(m.raw), st?.id || null, s.action, JSON.stringify(s.payload), demo ? 1 : 0);
    saved.push(r.lastInsertRowid);
  }
  return saved;
}
module.exports = { normalize, suggest, ingest, matchStudent, digits };
