import { DatabaseSync } from 'node:sqlite';

/**
 * The three tables that sync between devices. Every one of them carries the
 * same envelope columns (`updated_at`, `seq`, `deleted`) so the sync engine can
 * treat them identically.
 */
export const SYNC_TABLES = {
  leads: {
    columns: [
      'name', 'company', 'phone', 'email', 'source', 'status', 'value',
      'notes', 'tags', 'next_action', 'next_action_at', 'last_contact_at',
      'do_not_call', 'created_at',
    ],
    defaults: {
      name: '', company: '', phone: '', email: '', source: '', status: 'new',
      value: 0, notes: '', tags: '', next_action: '', next_action_at: null,
      last_contact_at: null, do_not_call: 0,
    },
    integers: ['value', 'next_action_at', 'last_contact_at', 'do_not_call', 'created_at'],
  },
  interactions: {
    columns: [
      'lead_id', 'kind', 'direction', 'outcome', 'summary', 'body',
      'occurred_at', 'duration_sec', 'created_at',
    ],
    defaults: {
      lead_id: '', kind: 'call', direction: 'out', outcome: '', summary: '',
      body: '', occurred_at: 0, duration_sec: 0,
    },
    integers: ['occurred_at', 'duration_sec', 'created_at'],
  },
  tasks: {
    columns: ['lead_id', 'title', 'notes', 'due_at', 'done_at', 'created_at'],
    defaults: { lead_id: '', title: '', notes: '', due_at: null, done_at: null },
    integers: ['due_at', 'done_at', 'created_at'],
  },
};

const MIGRATIONS = [
  // 1 -- initial schema
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    prefs         TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    next_seq      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE leads (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    company         TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL DEFAULT '',
    email           TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'new',
    value           INTEGER NOT NULL DEFAULT 0,
    notes           TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '',
    next_action     TEXT NOT NULL DEFAULT '',
    next_action_at  INTEGER,
    last_contact_at INTEGER,
    do_not_call     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    deleted         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX leads_user_seq ON leads(user_id, seq);

  CREATE TABLE interactions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    lead_id      TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL DEFAULT 'call',
    direction    TEXT NOT NULL DEFAULT 'out',
    outcome      TEXT NOT NULL DEFAULT '',
    summary      TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    occurred_at  INTEGER NOT NULL DEFAULT 0,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX interactions_user_seq ON interactions(user_id, seq);
  CREATE INDEX interactions_lead ON interactions(user_id, lead_id, occurred_at);

  CREATE TABLE tasks (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    lead_id    TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    due_at     INTEGER,
    done_at    INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tasks_user_seq ON tasks(user_id, seq);
  `,
];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);');

  const row = db.prepare('SELECT version FROM schema_meta').get();
  let version = row ? Number(row.version) : 0;
  if (!row) db.prepare('INSERT INTO schema_meta(version) VALUES(0)').run();

  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_meta SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Reserves `count` sequence numbers for a user and returns the first one. */
export function reserveSeq(db, userId, count) {
  const row = db.prepare('SELECT next_seq FROM users WHERE id = ?').get(userId);
  if (!row) throw new Error('unknown user');
  const first = Number(row.next_seq);
  db.prepare('UPDATE users SET next_seq = ? WHERE id = ?').run(first + count, userId);
  return first;
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transact(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}
