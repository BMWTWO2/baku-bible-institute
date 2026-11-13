// Durable storage for the WHOLE BBI database (students, roster, grades, attendance,
// homework, WhatsApp inbox, audit log) on Render's free tier, where the local disk is wiped
// on every restart/spin-down.
//
// How it works: the app keeps using SQLite (fast, unchanged code). When DATABASE_URL points
// at a Postgres database, every change is saved as a compressed SQLite snapshot in the table
// bbi_snapshots, and on boot the newest snapshot is restored before the app starts.
// With DATABASE_URL unset, nothing changes: the local SQLite file is used (and is lost on restart).
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const URL_ = process.env.DATABASE_URL || '';
const enabled = () => !!URL_;
const KEEP = Number(process.env.BBI_SNAPSHOT_KEEP || 30);
const dbFile = () => process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bbi.sqlite');
const marker = () => dbFile() + '.persist-ok';
let pool = null;
function getPool() {
  if (!pool) { const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
    pool = new Pool({ connectionString: URL_, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000, ssl: local ? false : { rejectUnauthorized: false } }); }
  return pool;
}
async function ensure() {
  await getPool().query(`CREATE TABLE IF NOT EXISTS bbi_snapshots (id BIGSERIAL PRIMARY KEY, data BYTEA NOT NULL, bytes INTEGER NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}
// Returns 'restored' | 'empty'. Throws if Postgres is unreachable (so we never boot a blank DB
// and then overwrite the real data with it).
async function restore() {
  await ensure();
  const r = await getPool().query('SELECT data FROM bbi_snapshots ORDER BY id DESC LIMIT 1');
  if (!r.rows.length) return 'empty';
  const f = dbFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
  for (const x of [f, f + '-wal', f + '-shm']) fs.rmSync(x, { force: true });
  fs.writeFileSync(f, zlib.gunzipSync(r.rows[0].data));
  return 'restored';
}
async function saveNow(db, reason) {
  const raw = db.serialize(); const gz = zlib.gzipSync(raw);
  await ensure();
  await getPool().query('INSERT INTO bbi_snapshots (data, bytes, reason) VALUES ($1,$2,$3)', [gz, raw.length, String(reason || '').slice(0, 80)]);
  await getPool().query('DELETE FROM bbi_snapshots WHERE id NOT IN (SELECT id FROM bbi_snapshots ORDER BY id DESC LIMIT $1)', [KEEP]);
}
const markOk = () => fs.writeFileSync(marker(), new Date().toISOString());
const isMarked = () => fs.existsSync(marker());
// Debounced saver used by the web server after any write request.
let timer = null; let dirty = false; let saving = null; let lastSavedAt = null; let lastError = null; let db_ = null;
function attach(db) { db_ = db; }
function schedule(reason) {
  if (!enabled() || !db_) return; dirty = reason || 'change';
  clearTimeout(timer); timer = setTimeout(flush, 2000);
}
async function flush() {
  if (!enabled() || !db_ || !dirty) return; if (saving) { await saving; if (!dirty) return; }
  const reason = dirty; dirty = false;
  saving = saveNow(db_, reason).then(() => { lastSavedAt = new Date().toISOString(); lastError = null; })
    .catch(e => { dirty = reason; lastError = String(e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[db-url]'); console.error('Snapshot save failed:', lastError); clearTimeout(timer); timer = setTimeout(flush, 30000); })
    .finally(() => { saving = null; });
  return saving;
}
const status = () => ({ durable: enabled(), lastSavedAt, lastError: lastError ? 'save failed (see logs)' : null });
async function close() { if (pool) await pool.end().catch(() => {}); pool = null; }
module.exports = { enabled, restore, saveNow, markOk, isMarked, attach, schedule, flush, status, close };
