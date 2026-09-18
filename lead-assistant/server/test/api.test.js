import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId } from '../../shared/records.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '../src/index.js');
const PORT = 8100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-api-'));
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'test-secret-value-that-is-long-enough',
      ANTHROPIC_API_KEY: '',
      SIGNUPS: 'open',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 120));
  }
});

after(() => {
  if (child) child.kill('SIGTERM');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, route, { token, body } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signUp(email) {
  const res = await call('POST', '/api/auth/register', {
    body: { email, password: 'correct horse battery', name: 'Test User', timezone: 'America/Denver' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('health reports what the server can do', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ai, false, 'no key configured in the test environment');
});

test('registering returns a working token', async () => {
  const { token, user } = await signUp(`a-${newId()}@example.com`);
  assert.ok(token);
  assert.equal(user.timezone, 'America/Denver');

  const me = await call('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, user.id);
});

test('weak passwords and bad emails are refused', async () => {
  const short = await call('POST', '/api/auth/register', {
    body: { email: `b-${newId()}@example.com`, password: 'short' },
  });
  assert.equal(short.status, 400);

  const bad = await call('POST', '/api/auth/register', {
    body: { email: 'not-an-email', password: 'long enough password' },
  });
  assert.equal(bad.status, 400);
});

test('the same email cannot be registered twice', async () => {
  const email = `c-${newId()}@example.com`;
  await signUp(email);
  const again = await call('POST', '/api/auth/register', {
    body: { email, password: 'another long password' },
  });
  assert.equal(again.status, 409);
});

test('signing in with the wrong password fails', async () => {
  const email = `d-${newId()}@example.com`;
  await signUp(email);
  const wrong = await call('POST', '/api/auth/login', { body: { email, password: 'nope nope nope' } });
  assert.equal(wrong.status, 401);

  const right = await call('POST', '/api/auth/login', { body: { email, password: 'correct horse battery' } });
  assert.equal(right.status, 200);
  assert.ok(right.body.token);
});

test('protected routes reject missing and forged tokens', async () => {
  assert.equal((await call('GET', '/api/sync')).status, 401);
  assert.equal((await call('GET', '/api/sync', { token: 'garbage.token' })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'a.b' })).status, 401);
});

test('a lead pushed from one device arrives on another', async () => {
  const { token } = await signUp(`e-${newId()}@example.com`);
  const leadId = newId();

  const phone = await call('POST', '/api/sync', {
    token,
    body: {
      since: 0,
      changes: {
        leads: [{
          id: leadId, name: 'Jordan Reyes', company: 'Blue Fin', phone: '555-0110',
          status: 'new', updated_at: Date.now(), created_at: Date.now(),
        }],
      },
    },
  });
  assert.equal(phone.status, 200);
  assert.equal(phone.body.written.applied, 1);

  // A second device starting from scratch sees it.
  const laptop = await call('GET', '/api/sync?since=0', { token });
  assert.equal(laptop.status, 200);
  assert.equal(laptop.body.changes.leads.length, 1);
  assert.equal(laptop.body.changes.leads[0].name, 'Jordan Reyes');
});

test('two accounts never see each other data', async () => {
  const alice = await signUp(`f-${newId()}@example.com`);
  const bob = await signUp(`g-${newId()}@example.com`);

  await call('POST', '/api/sync', {
    token: alice.token,
    body: { since: 0, changes: { leads: [{ id: newId(), name: 'Alice Lead', updated_at: Date.now() }] } },
  });

  const bobsView = await call('GET', '/api/sync?since=0', { token: bob.token });
  assert.equal(bobsView.body.changes.leads.length, 0);
});

test('the call list is ranked by the server too', async () => {
  const { token } = await signUp(`h-${newId()}@example.com`);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await call('POST', '/api/sync', {
    token,
    body: {
      since: 0,
      changes: {
        leads: [
          { id: 'overdue-lead', name: 'Overdue Person', next_action_at: now - 3 * day, next_action: 'Call back', last_contact_at: now - 5 * day, status: 'contacted', updated_at: now, created_at: now - 10 * day },
          { id: 'quiet-lead', name: 'Quiet Person', status: 'nurture', last_contact_at: now - day, updated_at: now, created_at: now - 10 * day },
        ],
      },
    },
  });

  const today = await call('GET', '/api/today', { token });
  assert.equal(today.status, 200);
  assert.equal(today.body.entries[0].leadId, 'overdue-lead');
  assert.equal(today.body.entries[0].bucket, 'overdue');
  assert.equal(today.body.counts.overdue, 1);
});

test('AI routes explain themselves when no key is configured', async () => {
  const { token } = await signUp(`i-${newId()}@example.com`);
  const brief = await call('POST', '/api/ai/brief', { token, body: {} });
  assert.equal(brief.status, 503);
  assert.match(brief.body.error, /API key/i);

  // Parsing still works, because it falls back to the offline reader.
  const parsed = await call('POST', '/api/ai/parse', {
    token,
    body: { text: 'left a voicemail for Dana, try again tomorrow' },
  });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.draft.outcome, 'voicemail');
  assert.ok(parsed.body.draft.nextActionAt > Date.now());
});

test('changing the password invalidates nothing else and still works', async () => {
  const email = `j-${newId()}@example.com`;
  const { token } = await signUp(email);

  const bad = await call('POST', '/api/auth/password', {
    token, body: { currentPassword: 'wrong', newPassword: 'a whole new password' },
  });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/api/auth/password', {
    token, body: { currentPassword: 'correct horse battery', newPassword: 'a whole new password' },
  });
  assert.equal(good.status, 200);

  const login = await call('POST', '/api/auth/login', {
    body: { email, password: 'a whole new password' },
  });
  assert.equal(login.status, 200);
});

test('oversized and malformed bodies are refused cleanly', async () => {
  const { token } = await signUp(`k-${newId()}@example.com`);
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{ this is not json',
  });
  assert.equal(res.status, 400);
});

test('unknown API paths 404 instead of falling through to the app', async () => {
  const res = await call('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
});
