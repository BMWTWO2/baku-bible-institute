// Email outbox. HARD RULE: nothing is ever sent automatically. Every email is queued as 'pending' and only
// leaves when Bruce clicks Send (or "Send all") on /admin/outbox, AND EMAIL_SENDING_ENABLED=true.
// Provider: SendGrid HTTPS API (Render free services cannot use SMTP ports 25/465/587), the same service the
// Front Door 4 Grace site uses to send as frontdoor4grace@gmail.com. Env: SENDGRID_API_KEY, EMAIL_FROM,
// EMAIL_FROM_NAME, EMAIL_REPLY_TO, EMAIL_SENDING_ENABLED.
const db = require('./db');
const SITE = () => process.env.SITE_URL || 'https://bakubibleinstitute.org';
const cfg = () => ({ enabled: process.env.EMAIL_SENDING_ENABLED === 'true', hasKey: !!process.env.SENDGRID_API_KEY,
  from: process.env.EMAIL_FROM || 'frontdoor4grace@gmail.com', fromName: process.env.EMAIL_FROM_NAME || 'Baku Bible Institute', replyTo: process.env.EMAIL_REPLY_TO || '' });
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function queue({ to, name, subject, text, kind, ref }) {
  const email = String(to || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return db.prepare('INSERT INTO email_outbox (to_email, to_name, subject, body_text, kind, ref) VALUES (?,?,?,?,?,?)').run(email, name || null, subject, text, kind || null, ref || null).lastInsertRowid;
}
const list = status => db.prepare(`SELECT * FROM email_outbox ${status && status !== 'all' ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 300`).all(...(status && status !== 'all' ? [status] : []));
const counts = () => Object.fromEntries(['pending', 'sent', 'failed', 'discarded'].map(s => [s, db.prepare('SELECT COUNT(*) n FROM email_outbox WHERE status=?').get(s).n]));
const discard = id => db.prepare(`UPDATE email_outbox SET status='discarded' WHERE id=? AND status IN ('pending','failed')`).run(id).changes === 1;
const edit = (id, subject, text) => db.prepare(`UPDATE email_outbox SET subject=?, body_text=? WHERE id=? AND status IN ('pending','failed')`).run(subject, text, id).changes === 1;
const remove = id => db.prepare('DELETE FROM email_outbox WHERE id=?').run(id).changes === 1;
// Called only from Bruce's explicit Send action.
async function send(id, by) {
  const c = cfg(); const m = db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id);
  if (!m || !['pending', 'failed'].includes(m.status)) return { ok: false, error: 'Not pending.' };
  if (!c.enabled) return { ok: false, error: 'Email sending is switched off (EMAIL_SENDING_ENABLED is not true).' };
  if (!c.hasKey) return { ok: false, error: 'No mail credential configured (SENDGRID_API_KEY).' };
  if (m.to_email.endsWith('.invalid')) { db.prepare(`UPDATE email_outbox SET status='failed', error='test address, not sent' WHERE id=?`).run(id); return { ok: false, error: 'Test address; not sent.' }; }
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: m.to_email, ...(m.to_name ? { name: m.to_name } : {}) }] }], from: { email: c.from, name: c.fromName },
        ...(c.replyTo ? { reply_to: { email: c.replyTo } } : {}), subject: m.subject, content: [{ type: 'text/plain', value: m.body_text }] }) });
    if (!r.ok) throw new Error('SendGrid ' + r.status);
    db.prepare(`UPDATE email_outbox SET status='sent', sent_at=?, approved_by=?, error=NULL WHERE id=?`).run(now(), by, id); return { ok: true };
  } catch (e) { db.prepare(`UPDATE email_outbox SET status='failed', error=?, approved_by=? WHERE id=?`).run(String(e.message).slice(0, 200), by, id); return { ok: false, error: e.message }; }
}
// Credential check WITHOUT sending anything: asks SendGrid which permissions the key has.
async function verify() {
  const c = cfg(); if (!c.hasKey) return { ok: false, detail: 'SENDGRID_API_KEY is not set on this service.' };
  try { const r = await fetch('https://api.sendgrid.com/v3/scopes', { headers: { authorization: 'Bearer ' + process.env.SENDGRID_API_KEY } });
    if (!r.ok) return { ok: false, detail: 'SendGrid rejected the key (HTTP ' + r.status + ').' };
    const j = await r.json(); const canSend = (j.scopes || []).includes('mail.send');
    return { ok: canSend, detail: canSend ? 'Key is valid and allowed to send mail. (No email was sent.)' : 'Key is valid but lacks the mail.send permission.' };
  } catch (e) { return { ok: false, detail: 'Could not reach SendGrid.' }; }
}
// Warm, simple Azeri templates in Pastor Bruce's style.
const first = n => String(n || '').split(' ')[0] || 'dostum';
const SIGN = '\n\nTəşəkkür edirik, Allah sizi bərəkətləndirsin.\nPastor Bruce Wright';
const OPEN = 'Bakı Müqəddəs Kitab İnstitutunda oxuduğunuz üçün təşəkkür edirik. Bu dərslər həm sizə, həm də ətrafınızdakı insanlara xeyir gətirir.';
const tplAssignment = ({ name, code, title, due, instructions }) => ({ subject: `Yeni tapşırıq: ${title}`,
  text: `Hörmətli ${first(name)},\n\n${OPEN}\n\n${code} dərsi üçün yeni tapşırıq var: «${title}».${due ? `\nSon tarix: ${due} (Bakı vaxtı).` : ''}${instructions ? `\n\n${instructions}` : ''}\n\nTapşırığı istənilən vaxt kabinetinizdən göndərə bilərsiniz:\n${SITE()}/telebe${SIGN}` });
const tplReturned = ({ name, title, feedback, score }) => ({ subject: `Tapşırığınıza rəy hazırdır: ${title}`,
  text: `Hörmətli ${first(name)},\n\n${OPEN}\n\n«${title}» tapşırığınızı yoxladım. Rəyim:\n\n${feedback}${score ? `\n\n${score}` : ''}\n\nRəyi kabinetinizdə də görə bilərsiniz:\n${SITE()}/telebe${SIGN}` });
module.exports = { cfg, queue, list, counts, discard, edit, remove, send, verify, tplAssignment, tplReturned };
