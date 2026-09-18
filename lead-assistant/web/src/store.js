import { api, askStream, setToken, ApiError } from './api.js';
import * as local from './local-db.js';
import { blankLead, blankInteraction, blankTask, draftToRecords } from '@shared/records.js';
import { rankLeads, summarize } from '@shared/priority.js';

const TABLES = local.TABLES;
const SYNC_INTERVAL_MS = 45000;
const PUSH_DEBOUNCE_MS = 1200;

let state = {
  phase: 'booting',
  user: null,
  aiEnabled: false,
  signupsOpen: true,
  leads: [],
  interactions: [],
  tasks: [],
  cursor: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  sync: { status: 'idle', lastSyncAt: null, pending: 0, message: '' },
};

const listeners = new Set();
const outbox = new Map();
let token = null;
let syncing = false;
let pushTimer = null;
let intervalTimer = null;
let syncAgain = false;

function emit(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() { return state; }

function setSync(patch) {
  emit({ sync: { ...state.sync, ...patch, pending: outbox.size } });
}

// --- boot -------------------------------------------------------------------

export async function boot() {
  let stored = { meta: {}, outbox: [], leads: [], interactions: [], tasks: [] };
  try {
    stored = await local.loadEverything();
  } catch (err) {
    console.warn('Local storage unavailable:', err);
  }

  for (const entry of stored.outbox || []) outbox.set(entry.key, entry);
  token = stored.meta?.token || null;
  setToken(token);

  emit({
    user: stored.meta?.user || null,
    cursor: Number(stored.meta?.cursor || 0),
    leads: stored.leads || [],
    interactions: stored.interactions || [],
    tasks: stored.tasks || [],
    phase: token ? 'ready' : 'signed-out',
    sync: { ...state.sync, pending: outbox.size },
  });

  api.health()
    .then((info) => emit({ aiEnabled: Boolean(info.ai), signupsOpen: info.signups !== false }))
    .catch(() => undefined);

  if (token) {
    sync();
    startTimers();
  }
}

function startTimers() {
  if (intervalTimer) return;
  intervalTimer = setInterval(() => sync(), SYNC_INTERVAL_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { emit({ online: true }); sync(); });
    window.addEventListener('offline', () => {
      emit({ online: false });
      setSync({ status: 'offline', message: 'Offline -- changes are saved here.' });
    });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync();
    });
  }
}

// --- auth -------------------------------------------------------------------

async function establishSession(result) {
  token = result.token;
  setToken(token);
  await local.setMeta('token', token);
  await local.setMeta('user', result.user);
  emit({ user: result.user, phase: 'ready' });
  startTimers();
  await sync();
}

export async function signIn(email, password) {
  const result = await api.login({ email, password });
  await establishSession(result);
}

export async function signUp({ email, password, name }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const result = await api.register({ email, password, name, timezone });
  await establishSession(result);
}

export async function signOut() {
  token = null;
  setToken(null);
  outbox.clear();
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  try { await local.wipeLocal(); } catch { /* nothing to clear */ }
  emit({
    phase: 'signed-out', user: null, leads: [], interactions: [], tasks: [], cursor: 0,
    sync: { status: 'idle', lastSyncAt: null, pending: 0, message: '' },
  });
}

export async function updateProfile(patch) {
  const result = await api.updateMe(patch);
  await local.setMeta('user', result.user);
  emit({ user: result.user });
  return result.user;
}

// --- writing ----------------------------------------------------------------

function replaceRow(list, row) {
  const index = list.findIndex((item) => item.id === row.id);
  if (index === -1) return [...list, row];
  const copy = [...list];
  copy[index] = row;
  return copy;
}

async function write(table, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return;

  let next = state[table];
  for (const row of list) {
    next = replaceRow(next, row);
    outbox.set(`${table}:${row.id}`, { key: `${table}:${row.id}`, table, id: row.id, updatedAt: row.updated_at });
  }
  emit({ [table]: next });
  setSync({ pending: outbox.size });

  try {
    await local.saveLocal(table, list);
  } catch (err) {
    console.warn('Could not save locally:', err);
  }
  schedulePush();
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; sync(); }, PUSH_DEBOUNCE_MS);
}

export function saveLead(patch) {
  const now = Date.now();
  const existing = patch.id ? state.leads.find((l) => l.id === patch.id) : null;
  const row = existing
    ? { ...existing, ...patch, updated_at: now }
    : blankLead({ ...patch, updated_at: now }, now);
  return write('leads', row).then(() => row);
}

export function saveInteraction(patch) {
  const now = Date.now();
  const existing = patch.id ? state.interactions.find((i) => i.id === patch.id) : null;
  const row = existing
    ? { ...existing, ...patch, updated_at: now }
    : blankInteraction({ ...patch, updated_at: now }, now);
  return write('interactions', row).then(() => row);
}

export function saveTask(patch) {
  const now = Date.now();
  const existing = patch.id ? state.tasks.find((t) => t.id === patch.id) : null;
  const row = existing
    ? { ...existing, ...patch, updated_at: now }
    : blankTask({ ...patch, updated_at: now }, now);
  return write('tasks', row).then(() => row);
}

export function removeRow(table, id) {
  const existing = state[table].find((row) => row.id === id);
  if (!existing) return Promise.resolve();
  return write(table, { ...existing, deleted: 1, updated_at: Date.now() });
}

/** Applies a parsed note: creates the lead if needed, logs it, sets the callback. */
export async function applyDraft(draft, overrides = {}) {
  const merged = { ...draft, ...overrides };
  const { createdLead, lead, interaction } = draftToRecords(merged, {
    leads: state.leads, now: Date.now(),
  });
  const now = Date.now();
  if (createdLead) await write('leads', { ...createdLead, updated_at: now });
  await write('leads', { ...lead, updated_at: now });
  await write('interactions', { ...interaction, updated_at: now });
  return { leadId: lead.id, interactionId: interaction.id, createdLead: Boolean(createdLead) };
}

/** Records an outcome from the Today screen in one tap. */
export async function logQuickOutcome(leadId, outcome, { nextActionAt = null, nextAction = '' } = {}) {
  const lead = state.leads.find((l) => l.id === leadId);
  if (!lead) return null;
  const now = Date.now();

  const interaction = blankInteraction({
    lead_id: leadId, kind: 'call', direction: 'out', outcome,
    summary: QUICK_SUMMARIES[outcome] || 'Call logged', occurred_at: now, updated_at: now,
  }, now);

  const reached = !NOT_REACHED.has(outcome);
  const patch = { updated_at: now };
  // A voicemail is an attempt, not a conversation. Only a real one counts.
  if (reached) patch.last_contact_at = now;

  if (outcome === 'not_interested') { patch.status = 'lost'; patch.next_action = ''; patch.next_action_at = null; }
  else if (outcome === 'closed_won') { patch.status = 'won'; patch.next_action = ''; patch.next_action_at = null; }
  else if (lead.status === 'new' && reached) patch.status = 'contacted';

  if (nextActionAt) {
    patch.next_action_at = nextActionAt;
    patch.next_action = nextAction || 'Follow up';
  } else if (!['not_interested', 'closed_won'].includes(outcome)) {
    // Clear the commitment only once it has actually come due -- a callback
    // booked for next Tuesday survives today's unanswered ring.
    if (lead.next_action_at != null && lead.next_action_at <= now) patch.next_action_at = null;
  }

  await write('interactions', interaction);
  await write('leads', { ...lead, ...patch });
  return interaction;
}

const NOT_REACHED = new Set(['no_answer', 'voicemail', 'wrong_number']);

const QUICK_SUMMARIES = {
  talked: 'Spoke with them',
  no_answer: 'No answer',
  voicemail: 'Left a voicemail',
  not_interested: 'Not interested',
  closed_won: 'Closed the deal',
  meeting_booked: 'Booked a meeting',
};

/** Pushes a callback out without recording a conversation. */
export function snooze(leadId, untilMs, label = 'Follow up') {
  const lead = state.leads.find((l) => l.id === leadId);
  if (!lead) return Promise.resolve();
  return write('leads', {
    ...lead, next_action_at: untilMs, next_action: lead.next_action || label, updated_at: Date.now(),
  });
}

// --- sync -------------------------------------------------------------------

function collectPending() {
  const entries = [...outbox.values()];
  const changes = {};
  const sent = [];
  for (const entry of entries) {
    const row = state[entry.table]?.find((item) => item.id === entry.id);
    if (!row) continue;
    (changes[entry.table] ||= []).push(row);
    sent.push({ ...entry, updatedAt: row.updated_at });
  }
  return { changes, sent };
}

export async function sync() {
  if (!token) return;
  if (syncing) { syncAgain = true; return; }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    setSync({ status: 'offline', message: 'Offline -- changes are saved here.' });
    return;
  }

  syncing = true;
  setSync({ status: 'syncing', message: '' });

  try {
    for (let round = 0; round < 25; round += 1) {
      const { changes, sent } = collectPending();
      const hasOutgoing = sent.length > 0;
      const result = hasOutgoing
        ? await api.push(state.cursor, changes)
        : await api.pull(state.cursor);

      // Only forget a queued row if it has not been edited again since sending.
      const settled = [];
      for (const entry of sent) {
        const current = outbox.get(entry.key);
        if (current && current.updatedAt === entry.updatedAt) {
          outbox.delete(entry.key);
          settled.push(entry);
        }
      }
      if (settled.length) {
        try { await local.clearOutbox(settled); } catch { /* retried next round */ }
      }

      await ingest(result.changes || {});
      emit({ cursor: result.cursor });
      try { await local.setMeta('cursor', result.cursor); } catch { /* not fatal */ }

      if (!result.hasMore && outbox.size === 0) break;
      if (!result.hasMore && !hasOutgoing) break;
    }

    setSync({ status: 'idle', lastSyncAt: Date.now(), message: '' });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await signOut();
      return;
    }
    const offline = err instanceof ApiError && err.offline;
    setSync({
      status: offline ? 'offline' : 'error',
      message: offline ? 'Offline -- changes are saved here.' : (err?.message || 'Sync failed'),
    });
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; setTimeout(() => sync(), 50); }
  }
}

/**
 * Merges server rows into memory and local storage. A row still waiting to be
 * sent, and edited more recently than the server copy, is left alone.
 */
async function ingest(changes) {
  const patch = {};
  const toPersist = {};

  for (const table of TABLES) {
    const rows = changes[table];
    if (!rows || !rows.length) continue;

    let next = state[table];
    const persist = [];
    for (const row of rows) {
      const pending = outbox.get(`${table}:${row.id}`);
      const mine = next.find((item) => item.id === row.id);
      if (pending && mine && Number(mine.updated_at) > Number(row.updated_at)) continue;
      next = replaceRow(next, row);
      persist.push(row);
    }
    if (persist.length) {
      patch[table] = next;
      toPersist[table] = persist;
    }
  }

  if (Object.keys(patch).length) emit(patch);
  if (Object.keys(toPersist).length) {
    try { await local.applyRemote(toPersist); } catch { /* memory still correct */ }
  }
}

export function forceSync() { return sync(); }

// --- reading ----------------------------------------------------------------

export function liveLeads(snapshot = state) {
  return snapshot.leads.filter((lead) => !lead.deleted);
}

export function interactionsFor(leadId, snapshot = state) {
  return snapshot.interactions
    .filter((item) => !item.deleted && item.lead_id === leadId)
    .sort((a, b) => (b.occurred_at || 0) - (a.occurred_at || 0));
}

export function timezoneOf(snapshot = state) {
  return snapshot.user?.timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
}

/** The ranked call list, computed on the device so it works with no signal. */
export function rankedList(snapshot = state, now = Date.now()) {
  return rankLeads({
    leads: snapshot.leads,
    interactions: snapshot.interactions,
    tasks: snapshot.tasks,
    now,
    timezone: timezoneOf(snapshot),
  });
}

export function bucketCounts(ranked) { return summarize(ranked); }

export { askStream };
