// node:sqlite è built-in in Node.js 22.5+ (stabile in Node 24) — nessuna dipendenza esterna
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../trimio.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migrazioni colonne opzionali
for (const sql of [
  'ALTER TABLE users ADD COLUMN photo_url TEXT',
  'ALTER TABLE users ADD COLUMN bio TEXT',
  'ALTER TABLE salons ADD COLUMN description TEXT',
  'ALTER TABLE salons ADD COLUMN cover_url TEXT',
]) {
  try { db.exec(sql); } catch {}
}

module.exports = db;
