const path = require('path'); const fs = require('fs'); const Database = require('better-sqlite3');
const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bbi.sqlite');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
// Additive migrations for databases restored from a durable snapshot (CREATE IF NOT EXISTS won't add columns).
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('assignments', 'due_at', 'TEXT');        // UTC ISO instant; entered/shown in Baku time
addCol('assignments', 'max_points', 'REAL');
addCol('assignments', 'late_policy', 'TEXT');   // e.g. "24:5, 72:10, 168:20, *:30"
module.exports = db;
