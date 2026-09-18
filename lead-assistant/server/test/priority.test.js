import test from 'node:test';
import assert from 'node:assert/strict';
import { rankLeads, scoreLead, summarize } from '../../shared/priority.js';
import { blankLead, blankInteraction } from '../../shared/records.js';
import { startOfDay, DAY_MS, HOUR_MS } from '../../shared/timezone.js';

const TZ = 'America/New_York';
// A fixed Wednesday afternoon so every assertion is reproducible.
const NOW = Date.parse('2026-03-11T18:30:00Z');

function lead(overrides) {
  return blankLead({ created_at: NOW - 30 * DAY_MS, updated_at: NOW, ...overrides }, NOW);
}

test('a missed callback outranks everything else', () => {
  const overdue = lead({ name: 'Overdue', next_action_at: NOW - 2 * DAY_MS, next_action: 'Call back', last_contact_at: NOW - 5 * DAY_MS });
  const today = lead({ name: 'Today', next_action_at: NOW + HOUR_MS, last_contact_at: NOW - DAY_MS });
  const fresh = lead({ name: 'Fresh', created_at: NOW });
  const cold = lead({ name: 'Cold', status: 'contacted', last_contact_at: NOW - 20 * DAY_MS });

  const ranked = rankLeads({ leads: [today, fresh, cold, overdue], now: NOW, timezone: TZ });
  assert.equal(ranked[0].lead.name, 'Overdue');
  assert.equal(ranked[0].bucket, 'overdue');
  assert.match(ranked[0].reason, /was due 2 days ago/);
});

test('scheduled-for-today sorts by time of day', () => {
  const dayStart = startOfDay(NOW, TZ);
  const morning = lead({ name: 'Morning', next_action_at: dayStart + 9 * HOUR_MS });
  const evening = lead({ name: 'Evening', next_action_at: dayStart + 20 * HOUR_MS });
  const ranked = rankLeads({ leads: [evening, morning], now: NOW, timezone: TZ });
  assert.deepEqual(ranked.map((e) => e.lead.name), ['Morning', 'Evening']);
  assert.equal(ranked[0].bucket, 'today');
});

test('a never-contacted lead is surfaced, and ages upward', () => {
  const todayLead = lead({ name: 'New today', created_at: NOW });
  const oldLead = lead({ name: 'New but stale', created_at: NOW - 10 * DAY_MS });
  const ranked = rankLeads({ leads: [todayLead, oldLead], now: NOW, timezone: TZ });
  assert.equal(ranked[0].lead.name, 'New but stale');
  assert.equal(ranked[0].bucket, 'new');
  assert.match(ranked[0].reason, /Never contacted, 10 days old/);
});

test('interactions count as contact, notes do not', () => {
  const withCall = lead({ id: 'a', name: 'Called', status: 'contacted' });
  const withNote = lead({ id: 'b', name: 'Noted', status: 'contacted' });
  const interactions = [
    blankInteraction({ lead_id: 'a', kind: 'call', occurred_at: NOW - HOUR_MS }, NOW),
    blankInteraction({ lead_id: 'b', kind: 'note', occurred_at: NOW - HOUR_MS }, NOW),
  ];
  const ranked = rankLeads({ leads: [withCall, withNote], interactions, now: NOW, timezone: TZ });
  const called = ranked.find((e) => e.leadId === 'a');
  const noted = ranked.find((e) => e.leadId === 'b');
  assert.equal(called.bucket, 'resting');
  assert.equal(noted.bucket, 'new', 'a note to self should not count as reaching the lead');
});

test('closed and do-not-call leads drop off the list entirely', () => {
  const leads = [
    lead({ name: 'Won', status: 'won' }),
    lead({ name: 'Lost', status: 'lost' }),
    lead({ name: 'Do not call', do_not_call: 1 }),
    lead({ name: 'Deleted', deleted: 1 }),
    lead({ name: 'Live' }),
  ];
  const ranked = rankLeads({ leads, now: NOW, timezone: TZ });
  assert.deepEqual(ranked.map((e) => e.lead.name), ['Live']);
});

test('deal size breaks ties but never beats a promise', () => {
  const big = lead({ name: 'Big', status: 'contacted', value: 100000, last_contact_at: NOW - 10 * DAY_MS });
  const small = lead({ name: 'Small', status: 'contacted', value: 100, last_contact_at: NOW - 10 * DAY_MS });
  const promised = lead({ name: 'Promised', status: 'contacted', value: 0, next_action_at: NOW - DAY_MS, last_contact_at: NOW - DAY_MS });

  const ranked = rankLeads({ leads: [small, big, promised], now: NOW, timezone: TZ });
  assert.equal(ranked[0].lead.name, 'Promised');
  assert.equal(ranked[1].lead.name, 'Big');
  assert.equal(ranked[2].lead.name, 'Small');
});

test('ranking is stable across repeated runs', () => {
  const leads = Array.from({ length: 25 }, (_, i) => lead({
    id: `lead-${i}`,
    name: `Lead ${i}`,
    status: ['new', 'contacted', 'hot', 'nurture'][i % 4],
    last_contact_at: NOW - (i % 7) * DAY_MS,
  }));
  const a = rankLeads({ leads, now: NOW, timezone: TZ }).map((e) => e.leadId);
  const b = rankLeads({ leads: [...leads].reverse(), now: NOW, timezone: TZ }).map((e) => e.leadId);
  assert.deepEqual(a, b, 'input order must not change the output order');
});

test('summarize counts each bucket', () => {
  const ranked = rankLeads({
    leads: [
      lead({ next_action_at: NOW - DAY_MS }),
      lead({ created_at: NOW }),
      lead({ status: 'contacted', last_contact_at: NOW - 30 * DAY_MS }),
    ],
    now: NOW,
    timezone: TZ,
  });
  const counts = summarize(ranked);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.new, 1);
  assert.equal(counts.due, 1);
});

test('scoring a single lead is side-effect free', () => {
  const l = lead({ name: 'Solo', next_action_at: NOW - DAY_MS });
  const snapshot = JSON.stringify(l);
  scoreLead(l, {
    now: NOW, timezone: TZ, interactionsByLead: new Map(), openTasksByLead: new Map(),
  });
  assert.equal(JSON.stringify(l), snapshot);
});
