const db = require('./db');
const HERALD_HOURS = Number(process.env.HERALD_HOURS || 48);
const unexcused = () => db.prepare(`SELECT s.id, s.name, c.code, sec.id section_id, COUNT(*) n FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN sections sec ON sec.id=cs.section_id JOIN courses c ON c.id=sec.course_id JOIN students s ON s.id=a.student_id WHERE a.status='absent' GROUP BY s.id, sec.id ORDER BY n DESC`).all();
const BOTS = [
  { key: 'shepherd', name: 'Shepherd', icon: '🕊️', watches: 'At-risk students: attendance under 75% or grade average under 70%.', flow: 'Attendance + grades → Shepherd → Director (weekly report) and teacher follow-up',
    run() { return db.prepare(`SELECT s.id, s.name,
        ROUND(100.0*SUM(CASE WHEN a.status IN ('present','late','excused') THEN 1 ELSE 0 END)/NULLIF(COUNT(a.id),0)) att,
        (SELECT ROUND(AVG(100.0*g.points/gi.max_points)) FROM grades g JOIN grade_items gi ON gi.id=g.grade_item_id WHERE g.student_id=s.id AND g.points IS NOT NULL) avg
        FROM students s LEFT JOIN attendance a ON a.student_id=s.id WHERE s.status='active' GROUP BY s.id HAVING att < 75 OR avg < 70`).all()
        .map(r => ({ text: `${r.name}: attendance ${r.att ?? '—'}%, average ${r.avg ?? '—'}%`, link: `/admin/students/${r.id}` })); } },
  { key: 'steward', name: 'Steward', icon: '🏛️', watches: 'Class capacity: sections at 90%+ or over capacity.', flow: 'Enrollments → Steward → Admin (open a new section / waitlist)',
    run() { return db.prepare(`SELECT sec.id, c.code, c.title, sec.capacity, COUNT(e.id) n FROM sections sec JOIN courses c ON c.id=sec.course_id LEFT JOIN enrollments e ON e.section_id=sec.id GROUP BY sec.id HAVING n >= 0.9*sec.capacity`).all()
        .map(r => ({ text: `${r.code} ${r.title}: ${r.n}/${r.capacity} seats`, link: '/admin/classes' })); } },
  { key: 'herald', name: 'Herald', icon: '📯', watches: `WhatsApp messages still pending after ${HERALD_HOURS} hours, and pending applicants.`, flow: 'WhatsApp webhook → Inbox → Herald → Admin (apply / dismiss)',
    run() { const m = db.prepare(`SELECT id, contact_name, from_number, received_at FROM whatsapp_messages WHERE status='pending' AND received_at < datetime('now', ?) ORDER BY received_at`).all(`-${HERALD_HOURS} hours`)
        .map(r => ({ text: `WhatsApp from ${r.contact_name || r.from_number} waiting since ${r.received_at.slice(0, 16).replace('T', ' ')}`, link: '/admin/whatsapp' }));
      const a = db.prepare(`SELECT id, name FROM students WHERE status='applicant'`).all().map(r => ({ text: `Applicant ${r.name} awaiting decision`, link: `/admin/students/${r.id}` }));
      return [...m, ...a]; } },
  { key: 'scribe', name: 'Scribe', icon: '📜', watches: 'Missing grades on items past their due date.', flow: 'Gradebook → Scribe → Teacher reminder',
    run() { return db.prepare(`SELECT gi.id, gi.title, c.code, s.name FROM grade_items gi JOIN sections sec ON sec.id=gi.section_id JOIN courses c ON c.id=sec.course_id JOIN enrollments e ON e.section_id=sec.id JOIN students s ON s.id=e.student_id LEFT JOIN grades g ON g.grade_item_id=gi.id AND g.student_id=s.id WHERE gi.due_date < date('now') AND (g.id IS NULL OR g.points IS NULL) ORDER BY c.code`).all()
        .map(r => ({ text: `${r.code} · ${r.title}: no grade for ${r.name}`, link: `/admin/gradebook/${r.id}` })); } },
  { key: 'watchman', name: 'Watchman', icon: '🗼', watches: 'Data integrity: missing phones, duplicate phones, attendance for non-enrolled students, unlinked WhatsApp senders.', flow: 'Whole database → Watchman → Admin clean-up list',
    run() { const out = [];
      db.prepare(`SELECT id, name FROM students WHERE (whatsapp_phone IS NULL OR whatsapp_phone='') AND status='active'`).all().forEach(r => out.push({ text: `${r.name} has no WhatsApp number`, link: `/admin/students/${r.id}` }));
      db.prepare(`SELECT whatsapp_phone p, GROUP_CONCAT(name, ', ') names FROM students WHERE whatsapp_phone<>'' GROUP BY whatsapp_phone HAVING COUNT(*)>1`).all().forEach(r => out.push({ text: `Duplicate phone ${r.p}: ${r.names}`, link: '/admin/students' }));
      db.prepare(`SELECT DISTINCT s.name FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN students s ON s.id=a.student_id LEFT JOIN enrollments e ON e.student_id=s.id AND e.section_id=cs.section_id WHERE e.id IS NULL`).all().forEach(r => out.push({ text: `${r.name} has attendance in a class they are not enrolled in`, link: '/admin/attendance' }));
      db.prepare(`SELECT COUNT(*) n FROM whatsapp_messages WHERE student_id IS NULL AND status='pending'`).all().forEach(r => r.n && out.push({ text: `${r.n} pending WhatsApp message(s) from unknown numbers`, link: '/admin/whatsapp' }));
      return out; } },
  { key: 'sentinel', name: 'Sentinel', icon: '🛡️', watches: 'Any student with MORE THAN 2 unexcused absences in a class (excused absences do not count).', flow: 'Attendance → Sentinel → Flag on roster + Director report',
    run() { return unexcused().filter(r => r.n > 2).map(r => ({ text: `${r.name}: ${r.n} unexcused absences in ${r.code}`, link: `/admin/students/${r.id}` })); } },
  { key: 'helper', name: 'Homework Helper', icon: '✍️', watches: 'Homework submissions awaiting review; drafts Azerbaijani corrections for a professor to approve.', flow: 'Student submission (web/WhatsApp) → Helper draft (az) → Professor approves → Student sees feedback',
    run() { return db.prepare(`SELECT sb.id, s.name, a.title_az, sb.status FROM submissions sb JOIN students s ON s.id=sb.student_id JOIN assignments a ON a.id=sb.assignment_id WHERE sb.status<>'returned' ORDER BY sb.submitted_at`).all()
        .map(r => ({ text: `${r.name} — «${r.title_az}» (${r.status === 'draft_ready' ? 'draft ready' : 'needs draft'})`, link: `/admin/homework/${r.id}` })); } },
];
BOTS.push({ key: 'chronicler', name: 'Chronicler', icon: '📖', watches: 'Compiles every bot’s findings into the weekly director’s report.', flow: 'All bots → Chronicler → Weekly report (Bruce)', run: () => [] });
function runAll() { const res = {}; for (const b of BOTS) if (b.key !== 'chronicler') res[b.key] = b.run(); return res; }
function weeklyReport() {
  const f = runAll(); const c = q => db.prepare(q).get().n;
  return { generated: new Date().toISOString(), findings: f,
    totals: { students: c(`SELECT COUNT(*) n FROM students WHERE status='active'`), applicants: c(`SELECT COUNT(*) n FROM students WHERE status='applicant'`), sections: c('SELECT COUNT(*) n FROM sections'),
      pendingWhatsApp: c(`SELECT COUNT(*) n FROM whatsapp_messages WHERE status='pending'`), homeworkAwaiting: c(`SELECT COUNT(*) n FROM submissions WHERE status<>'returned'`),
      attendanceRate: db.prepare(`SELECT ROUND(100.0*SUM(status IN ('present','late','excused'))/NULLIF(COUNT(*),0)) n FROM attendance`).get().n } };
}
module.exports = { BOTS, runAll, weeklyReport, unexcused };
