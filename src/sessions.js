// Durable express-session store. When DATABASE_URL is set, sessions live in a small
// Postgres table (bbi_sessions) so they survive Render restarts and free-plan spin-downs.
// Without DATABASE_URL, express-session's memory store is used (local/dev only).
const crypto = require('crypto');
const session = require('express-session');

const URL_ = process.env.DATABASE_URL || '';
const COOKIE_MS = 1000 * 60 * 60 * 8;
const prune = (e) => String(e && e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[db-url]');

function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length >= 16) return { value: s, set: true };
  if (process.env.NODE_ENV === 'production' && URL_) {
    console.error('SESSION_SECRET is missing or too short; sessions will not survive a restart until it is set to a stable value.');
  }
  return { value: s || crypto.randomBytes(32).toString('hex'), set: false };
}

function store() {
  if (!URL_) return null;
  const { Pool } = require('pg');
  const PgStore = require('connect-pg-simple')(session);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
  const pool = new Pool({ connectionString: URL_, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000, ssl: local ? false : { rejectUnauthorized: false } });
  return new PgStore({
    pool,
    tableName: 'bbi_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 6 * 60 * 60, // seconds; keep Neon quiet
    ttl: COOKIE_MS / 1000,
    errorLog: err => console.error('Session store:', prune(err))
  });
}

function middleware() {
  const sec = secret();
  const st = store();
  if (st) console.log('Sessions: stored in Postgres (bbi_sessions). SESSION_SECRET is ' + (sec.set ? 'set.' : 'NOT set.'));
  else console.log('Sessions: in-memory only (no DATABASE_URL). SESSION_SECRET is ' + (sec.set ? 'set.' : 'not set (a random one is used for this process).'));
  return session({
    name: 'bbi.sid',
    secret: sec.value,
    store: st || undefined,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: COOKIE_MS }
  });
}

function safeNext(req) {
  let p = '';
  const ref = req.get('referer');
  if (ref) { try { const u = new URL(ref); p = u.pathname + u.search; } catch {} }
  if (!p.startsWith('/') || p.startsWith('//')) {
    const o = String(req.originalUrl || req.path || '/');
    p = o.startsWith('/') && !o.startsWith('//') ? o : '/';
  }
  if (p.startsWith('/login') || p.startsWith('/logout')) p = '/';
  return p;
}

function csrfGuard(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const api = req.path.startsWith('/api/') || req.path.startsWith('/webhooks/');
  if (req.method === 'POST' && req.body?._csrf !== req.session.csrf) {
    if (api) return res.status(403).json({ error: 'invalid csrf token' });
    const nextPath = safeNext(req);
    if (!req.session.user) {
      req.session.flash = 'Your session expired. Please sign in again.';
      return res.redirect('/login?next=' + encodeURIComponent(nextPath));
    }
    req.session.flash = 'That form was out of date. Please try again.';
    return res.redirect(nextPath);
  }
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.user || null;
  res.locals.demo = req.app.get('demo');
  res.locals.path = req.path;
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
}

module.exports = { middleware, csrfGuard, safeNext, secret, COOKIE_MS };
