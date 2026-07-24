'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Шлях до файлу БД. На Render можна змінити через змінну DATA_DIR
// (напр. на змонтований диск /var/data), щоб дані не зникали при деплої.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'ideas.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Таблиця ідей
db.exec(`
  CREATE TABLE IF NOT EXISTS ideas (
    id       TEXT PRIMARY KEY,
    name     TEXT,
    cat      TEXT NOT NULL,
    text     TEXT NOT NULL,
    contact  TEXT,
    votes    INTEGER NOT NULL DEFAULT 0,
    status   TEXT NOT NULL DEFAULT 'нова',
    ts       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    idea_id   TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (idea_id, client_id)
  );

  CREATE INDEX IF NOT EXISTS idx_ideas_ts ON ideas(ts);
`);

module.exports = db;
