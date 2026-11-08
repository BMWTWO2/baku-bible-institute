const path = require('path'); const fs = require('fs'); const Database = require('better-sqlite3');
const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bbi.sqlite');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
module.exports = db;
