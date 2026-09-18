import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/db.js';
import { pull, push, coerceRow, loadAll } from '../src/sync.js';
import { newId } from '../../shared/records.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-sync-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const users = ['user-a', 'user-b'];
  for (const id of users) {
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, timezone, prefs, created_at, next_seq)
       VALUES (?, ?, '', 'x', 'UTC', '{}', ?, 1)`,
    ).run(id, `${id}@example.com`, Date.now());
  }
  return { db, dir };
}

function leadChange(overrides = {}) {
  return { id: newId(), name: 'Test', updated_at: 1000, created_at: 1000, ...overrides };
}

test('a pushed row comes back on the next pull', () => {
  const { db } = freshDb();
  const row = leadChange({ name: 'Dana' });
  const written = push(db, 'user-a', { leads: [row] });
  assert.equal(written.applied, 1);

  const { changes, cursor } = pull(db, 'user-a', 0);
  assert.equal(changes.leads.length, 1);
  assert.equal(changes.leads[0].name, 'Dana');
  assert.ok(cursor > 0);

  const again = pull(db, 'user-a', cursor);
  assert.equal(again.count, 0, 'nothing new after catching up');
});

test('the newer edit wins no matter which device sends it', () => {
  const { db } = freshDb();
  const id = newId();
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Old', updated_at: 1000 })] });
  push(db, 'user-a', { leads: [leadChange({ id, name: 'New', updated_at: 2000 })] });
  assert.equal(pull(db, 'user-a', 0).changes.leads[0].name, 'New');

  // A stale write arriving late must not overwrite the newer value.
  const late = push(db, 'user-a', { leads: [leadChange({ id, name: 'Stale', updated_at: 1500 })] });
  assert.equal(late.skipped, 1);
  assert.equal(pull(db, 'user-a', 0).changes.leads[0].name, 'New');
});

test('one account cannot touch another account rows', () => {
  const { db } = freshDb();
  const id = newId();
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Private' })] });

  const attempt = push(db, 'user-b', { leads: [leadChange({ id, name: 'Stolen', updated_at: 9999 })] });
  assert.equal(attempt.rejected, 1);
  assert.equal(attempt.applied, 0);
  assert.equal(pull(db, 'user-a', 0).changes.leads[0].name, 'Private');
  assert.equal(pull(db, 'user-b', 0).count, 0);
});

test('deletes travel as tombstones', () => {
  const { db } = freshDb();
  const id = newId();
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Gone' })] });
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Gone', updated_at: 2000, deleted: true })] });

  const { changes } = pull(db, 'user-a', 0);
  assert.equal(changes.leads.length, 1);
  assert.equal(changes.leads[0].deleted, 1, 'the peer must learn about the delete');
  assert.equal(loadAll(db, 'user-a').leads.length, 0);
});

test('a truncated page never skips a change', () => {
  const { db } = freshDb();
  const leads = Array.from({ length: 7 }, (_, i) => leadChange({ name: `Lead ${i}` }));
  push(db, 'user-a', { leads });

  const seen = new Set();
  let cursor = 0;
  let rounds = 0;
  for (;;) {
    const page = pull(db, 'user-a', cursor, 3);
    for (const row of page.changes.leads) seen.add(row.name);
    cursor = page.cursor;
    rounds += 1;
    if (!page.hasMore || rounds > 10) break;
  }
  assert.equal(seen.size, 7, 'every row arrived across the pages');
});

test('junk from a client is coerced or rejected, never stored raw', () => {
  const now = 5000;
  assert.equal(coerceRow('leads', { id: '' }, 'user-a', now), null);
  assert.equal(coerceRow('leads', null, 'user-a', now), null);
  assert.equal(coerceRow('nope', { id: 'x' }, 'user-a', now), null);

  const row = coerceRow('leads', {
    id: 'abc',
    user_id: 'somebody-else',
    value: '2500',
    do_not_call: true,
    next_action_at: 'not a date',
    unknown_column: 'DROP TABLE leads',
  }, 'user-a', now);

  assert.equal(row.user_id, 'user-a', 'ownership comes from the token, not the payload');
  assert.equal(row.value, 2500);
  assert.equal(row.do_not_call, 1);
  assert.equal(row.next_action_at, null);
  assert.equal(row.unknown_column, undefined);
  assert.equal(row.status, 'new', 'missing fields fall back to defaults');
});

test('a full round trip keeps two devices in step', () => {
  const { db } = freshDb();
  const phone = { cursor: 0 };
  const laptop = { cursor: 0 };

  const id = newId();
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Shared', updated_at: 1000 })] });
  phone.cursor = pull(db, 'user-a', phone.cursor).cursor;

  // The laptop edits while the phone is offline.
  push(db, 'user-a', { leads: [leadChange({ id, name: 'Shared', company: 'Acme', updated_at: 2000 })] });
  laptop.cursor = pull(db, 'user-a', laptop.cursor).cursor;

  const catchUp = pull(db, 'user-a', phone.cursor);
  assert.equal(catchUp.changes.leads.length, 1);
  assert.equal(catchUp.changes.leads[0].company, 'Acme');
});

test('interactions and tasks sync alongside leads', () => {
  const { db } = freshDb();
  const leadId = newId();
  const result = push(db, 'user-a', {
    leads: [leadChange({ id: leadId })],
    interactions: [{ id: newId(), lead_id: leadId, kind: 'call', summary: 'Spoke', occurred_at: 1000, updated_at: 1000 }],
    tasks: [{ id: newId(), lead_id: leadId, title: 'Send quote', due_at: 2000, updated_at: 1000 }],
  });
  assert.equal(result.applied, 3);

  const data = loadAll(db, 'user-a');
  assert.equal(data.interactions[0].summary, 'Spoke');
  assert.equal(data.tasks[0].title, 'Send quote');
});
