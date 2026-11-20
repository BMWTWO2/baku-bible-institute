// Self-service "Forgot password?". Works for every role (admin, teacher, student).
// - Only the SHA-256 hash of a random 32-byte token is stored (table password_resets); single use; 60-minute expiry.
// - The email goes ONLY to the account's own stored address, immediately (transactional; never via the approval outbox).
// - The request page always answers the same neutral message, so it never reveals which emails have accounts.
const crypto = require('crypto'); const bcrypt = require('bcryptjs');
const db = require('./db'); const outbox = require('./outbox');
const SITE = () => process.env.SITE_URL || 'https://bakubibleinstitute.org';
const TTL_MS = 60 * 60e3, WINDOW_MS = 60 * 60e3, MAX_PER_EMAIL = 3, MAX_PER_IP = 10, MIN_LEN = 8;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const iso = d => new Date(d).toISOString();
const hitsEmail = new Map(), hitsIp = new Map();
function hit(map, key, max) {
  const now = Date.now(); const a = map.get(key) || { n: 0, t: now };
  if (now - a.t > WINDOW_MS) { a.n = 0; a.t = now; }
  a.n++; map.set(key, a);
  if (map.size > 5000) for (const [k, v] of map) if (now - v.t > WINDOW_MS) map.delete(k);
  return a.n > max;
}
const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 254);

function emailText(link) {
  return `Hörmətli dostum,

Siz Bakı Müqəddəs Kitab İnstitutunun saytında şifrənizi dəyişmək istədiniz.
Yeni şifrə təyin etmək üçün bu linkə basın:

${link}

Bu link 1 saat işləyir və yalnız bir dəfə istifadə olunur.
Əgər siz bunu istəməmisinizsə, bu məktuba fikir verməyin. Heç nə dəyişməyəcək.

Təşəkkür edirəm, Allah sizi xeyir-dua etsin.
Pastor Bruce Wright

----------

Dear friend,

You asked to change your password on the Baku Bible Institute website.
Click this link to choose a new password:

${link}

This link works for 1 hour and can be used only once.
If you did not ask for this, just ignore this email. Nothing will change.

Thank you, and God bless you.
Pastor Bruce Wright
`;
}

// Returns { limited, sent, reason }. The caller shows the SAME message whatever this returns.
async function request(rawEmail, ip) {
  const email = normEmail(rawEmail);
  const ipLimited = hit(hitsIp, String(ip || 'unknown'), MAX_PER_IP);
  const emailLimited = email ? hit(hitsEmail, email, MAX_PER_EMAIL) : false;
  if (ipLimited || emailLimited || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { limited: ipLimited || emailLimited, sent: false, reason: 'skipped' };
  const u = db.prepare('SELECT id, email FROM users WHERE lower(email)=?').get(email);
  if (!u) return { sent: false, reason: 'no-account' };
  // Survives restarts: at most MAX_PER_EMAIL tokens per user per hour.
  const recent = db.prepare('SELECT COUNT(*) n FROM password_resets WHERE user_id=? AND created_at > ?').get(u.id, iso(Date.now() - WINDOW_MS).replace('T', ' ').slice(0, 19)).n;
  if (recent >= MAX_PER_EMAIL) return { limited: true, sent: false, reason: 'limited' };
  const c = outbox.cfg();
  if (!outbox.canSendTransactional()) return { sent: false, reason: 'email-disabled' };
  const token = crypto.randomBytes(32).toString('hex');
  // Older unused tokens for this user stop working the moment a new one is issued.
  // Rows are kept (marked used) so the per-user hourly limit survives restarts; rows older than a day are purged.
  const stamp = iso(Date.now()).replace('T', ' ').slice(0, 19);
  db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(stamp, u.id);
  db.prepare('DELETE FROM password_resets WHERE created_at < ?').run(iso(Date.now() - 864e5).replace('T', ' ').slice(0, 19));
  db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)').run(u.id, sha(token), iso(Date.now() + TTL_MS));
  const link = `${SITE()}/reset-password?token=${token}`;
  const r = await outbox.sendTransactional({ to: u.email, subject: 'Şifrənizi dəyişin · Reset your password', text: emailText(link) });
  if (!r.ok) { db.prepare('DELETE FROM password_resets WHERE token_hash=?').run(sha(token)); return { sent: false, reason: 'send-failed', error: r.error }; }
  return { sent: true, user_id: u.id, from: c.from };
}

function lookup(token) {
  const t = String(token || ''); if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const r = db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(sha(t));
  if (!r || r.used_at || Date.parse(r.expires_at) < Date.now()) return null;
  return r;
}
// Returns { ok, user } or { error: 'invalid'|'short'|'mismatch' }.
function complete(token, pw, confirm) {
  const r = lookup(token); if (!r) return { error: 'invalid' };
  pw = String(pw || '');
  if (pw.length < MIN_LEN) return { error: 'short' };
  if (pw !== String(confirm || '')) return { error: 'mismatch' };
  const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(r.user_id); if (!user) return { error: 'invalid' };
  const hash = bcrypt.hashSync(pw, 10);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
    db.prepare(`UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL`).run(iso(Date.now()).replace('T', ' ').slice(0, 19), user.id);
  })();
  return { ok: true, user };
}
module.exports = { request, lookup, complete, MIN_LEN, _hits: { hitsEmail, hitsIp } };
