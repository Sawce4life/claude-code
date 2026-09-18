import { SYNC_TABLES, reserveSeq, transact } from './db.js';

export const PAGE_SIZE = 400;
const MAX_TEXT = 20000;

const ENVELOPE = ['id', 'user_id', 'updated_at', 'seq', 'deleted'];

function coerceInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function coerceText(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/**
 * Turns whatever a client sent into a row this server is willing to store.
 * Anything unrecognised is dropped rather than trusted.
 */
export function coerceRow(table, input, userId, now) {
  const spec = SYNC_TABLES[table];
  if (!spec) return null;
  if (!input || typeof input !== 'object') return null;

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id || id.length > 64) return null;

  const updatedAt = coerceInteger(input.updated_at) ?? now;
  const row = {
    id,
    user_id: userId,
    updated_at: updatedAt,
    deleted: input.deleted ? 1 : 0,
  };

  for (const column of spec.columns) {
    const given = input[column];
    if (spec.integers.includes(column)) {
      const fallback = spec.defaults[column];
      row[column] = given === undefined
        ? (fallback === undefined ? null : fallback)
        : coerceInteger(given);
    } else {
      row[column] = given === undefined
        ? (spec.defaults[column] ?? '')
        : coerceText(given);
    }
  }

  if (row.created_at == null) row.created_at = updatedAt;
  return row;
}

/** Everything this user changed after `since`, oldest change first. */
export function pull(db, userId, since = 0, pageSize = PAGE_SIZE) {
  const cursor = Number.isFinite(Number(since)) ? Math.max(0, Math.trunc(Number(since))) : 0;
  const changes = {};
  let highest = cursor;
  let hasMore = false;

  for (const table of Object.keys(SYNC_TABLES)) {
    const rows = db.prepare(
      `SELECT * FROM ${table} WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(userId, cursor, pageSize + 1);

    if (rows.length > pageSize) {
      hasMore = true;
      rows.length = pageSize;
    }
    changes[table] = rows.map((row) => ({ ...row }));
    for (const row of rows) {
      if (row.seq > highest) highest = Number(row.seq);
    }
  }

  // When a page was truncated, only advance to the lowest safe watermark so no
  // change is skipped on the next round trip.
  if (hasMore) {
    let safe = Infinity;
    for (const table of Object.keys(changes)) {
      const rows = changes[table];
      if (rows.length === pageSize) safe = Math.min(safe, Number(rows[rows.length - 1].seq));
    }
    if (Number.isFinite(safe)) {
      for (const table of Object.keys(changes)) {
        changes[table] = changes[table].filter((row) => Number(row.seq) <= safe);
      }
      highest = safe;
    }
  }

  const total = Object.values(changes).reduce((n, rows) => n + rows.length, 0);
  return { cursor: highest, changes, hasMore, count: total };
}

/**
 * Applies a batch of client changes. Last write wins, compared on the client's
 * own `updated_at`, so an edit made offline yesterday never clobbers one made
 * on another device today.
 */
export function push(db, userId, incoming = {}, now = Date.now()) {
  const result = { applied: 0, skipped: 0, rejected: 0, ids: {} };

  const prepared = [];
  for (const table of Object.keys(SYNC_TABLES)) {
    const rows = Array.isArray(incoming[table]) ? incoming[table] : [];
    for (const raw of rows) {
      const row = coerceRow(table, raw, userId, now);
      if (!row) { result.rejected += 1; continue; }
      prepared.push({ table, row });
    }
  }
  if (!prepared.length) return result;

  transact(db, () => {
    let seq = reserveSeq(db, userId, prepared.length);

    for (const { table, row } of prepared) {
      const spec = SYNC_TABLES[table];
      const existing = db.prepare(
        `SELECT user_id, updated_at FROM ${table} WHERE id = ?`,
      ).get(row.id);

      if (existing && existing.user_id !== userId) {
        result.rejected += 1;
        continue;
      }
      if (existing && Number(existing.updated_at) >= row.updated_at) {
        result.skipped += 1;
        continue;
      }

      const columns = [...ENVELOPE.filter((c) => c !== 'seq'), 'seq', ...spec.columns];
      const values = columns.map((c) => (c === 'seq' ? seq : row[c]));
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${
           columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
         }`,
      ).run(...values);

      (result.ids[table] ||= []).push(row.id);
      seq += 1;
      result.applied += 1;
    }
  });

  return result;
}

/** Everything the user owns, for screens that need the whole picture. */
export function loadAll(db, userId) {
  const out = {};
  for (const table of Object.keys(SYNC_TABLES)) {
    out[table] = db.prepare(
      `SELECT * FROM ${table} WHERE user_id = ? AND deleted = 0`,
    ).all(userId).map((row) => ({ ...row }));
  }
  return out;
}
