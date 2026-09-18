import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { units } from './security.mjs';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, exchange TEXT NOT NULL, label TEXT NOT NULL,
      secret TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
      start INTEGER NOT NULL, options TEXT NOT NULL, created INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', error TEXT, synced INTEGER, disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL REFERENCES connections(id),
      status TEXT NOT NULL DEFAULT 'queued', checkpoint TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0, next_run INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(connection_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS events (
      connection_id TEXT NOT NULL REFERENCES connections(id), stream TEXT NOT NULL, external_id TEXT NOT NULL,
      time INTEGER NOT NULL, kind TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, currency TEXT NOT NULL,
      gross TEXT NOT NULL, fee TEXT NOT NULL, funding TEXT NOT NULL, raw TEXT NOT NULL,
      PRIMARY KEY(connection_id,stream,external_id)
    );
    CREATE INDEX IF NOT EXISTS events_time ON events(time);
    CREATE TABLE IF NOT EXISTS snapshots (
      connection_id TEXT PRIMARY KEY REFERENCES connections(id), time INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS day_notes (
      date TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_images (
      id TEXT PRIMARY KEY, date TEXT NOT NULL REFERENCES day_notes(date) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_images_date ON note_images(date,created);
    CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
  return db;
}
export function enqueue(db, id) {
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO jobs(connection_id,created,updated) VALUES(?,?,?)").run(id, now, now);
}
export function savePage(db, connectionId, stream, events, jobId, checkpoint) {
  const insert = db.prepare(`INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(connection_id,stream,external_id) DO UPDATE SET time=excluded.time,
    kind=excluded.kind,market=excluded.market,symbol=excluded.symbol,currency=excluded.currency,
    gross=excluded.gross,fee=excluded.fee,funding=excluded.funding,raw=excluded.raw`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of events) {
      if (!e.id || ['undefined','null'].includes(String(e.id)) || !Number.isFinite(e.time)) throw new Error('Invalid exchange record');
      for (const amount of [e.gross,e.fee,e.funding]) units(amount || '0');
      insert.run(connectionId, stream, String(e.id), e.time, e.kind, e.market, e.symbol || '', e.currency || '', e.gross || '0', e.fee || '0', e.funding || '0', JSON.stringify(e.raw));
    }
    db.prepare('UPDATE jobs SET checkpoint=?,updated=? WHERE id=?').run(JSON.stringify(checkpoint), Date.now(), jobId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
