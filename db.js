const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const FILES_DIR = path.join(config.dataDir, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'slot.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mime        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('in', 'out')), -- in = from a client, out = from an admin
    sender      TEXT NOT NULL DEFAULT '',
    ip          TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL DEFAULT '',
    token       TEXT UNIQUE,                                  -- public share token, only for 'out'
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_expires ON files (expires_at);
  CREATE INDEX IF NOT EXISTS files_kind_created ON files (kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,   -- sha256 of the cookie value
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
  insertFile: db.prepare(`INSERT INTO files (id, name, size, mime, kind, sender, ip, uploaded_by, token, created_at, expires_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getFile: db.prepare('SELECT * FROM files WHERE id = ? AND expires_at > ?'),
  getByToken: db.prepare("SELECT * FROM files WHERE token = ? AND kind = 'out' AND expires_at > ?"),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  expired: db.prepare('SELECT id FROM files WHERE expires_at <= ?'),
  allIds: db.prepare('SELECT id FROM files'),
  usedBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE expires_at > ?'),
  insertSession: db.prepare('INSERT INTO sessions (id, username, expires_at) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

function listFiles({ kind, search, now }) {
  const where = ['expires_at > ?'];
  const args = [now];
  if (kind === 'in' || kind === 'out') {
    where.push('kind = ?');
    args.push(kind);
  }
  if (search) {
    where.push('(LOWER(name) LIKE ? ESCAPE \'\\\' OR LOWER(sender) LIKE ? ESCAPE \'\\\')');
    const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    args.push(like, like);
  }
  return db
    .prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1000`)
    .all(...args);
}

function countByKind(now) {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM files WHERE expires_at > ? GROUP BY kind').all(now);
  const out = { in: 0, out: 0 };
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

module.exports = { db, q, listFiles, countByKind, FILES_DIR };
