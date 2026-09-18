/**
 * Record shapes and the small amount of logic that creates or updates them.
 * Shared by the server and the app so both write identical rows.
 */

export function newId() {
  // Random enough to never collide across devices, short enough to read.
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function blankLead(overrides = {}, now = Date.now()) {
  return {
    id: newId(),
    name: '',
    company: '',
    phone: '',
    email: '',
    source: '',
    status: 'new',
    value: 0,
    notes: '',
    tags: '',
    next_action: '',
    next_action_at: null,
    last_contact_at: null,
    do_not_call: 0,
    created_at: now,
    updated_at: now,
    deleted: 0,
    ...overrides,
  };
}

export function blankInteraction(overrides = {}, now = Date.now()) {
  return {
    id: newId(),
    lead_id: '',
    kind: 'call',
    direction: 'out',
    outcome: '',
    summary: '',
    body: '',
    occurred_at: now,
    duration_sec: 0,
    created_at: now,
    updated_at: now,
    deleted: 0,
    ...overrides,
  };
}

export function blankTask(overrides = {}, now = Date.now()) {
  return {
    id: newId(),
    lead_id: '',
    title: '',
    notes: '',
    due_at: null,
    done_at: null,
    created_at: now,
    updated_at: now,
    deleted: 0,
    ...overrides,
  };
}

/** Outcomes that count as having actually reached the person. */
const REACHED = new Set(['talked', 'meeting_booked', 'closed_won', 'not_interested', 'callback']);

/**
 * Turns a parsed note into the concrete rows to write: possibly a new lead,
 * one interaction, and the updated lead fields. Pure, so it can be tested and
 * so the client can preview exactly what will be saved.
 */
export function draftToRecords(draft, { leads = [], now = Date.now() } = {}) {
  const existing = draft.leadId ? leads.find((l) => l.id === draft.leadId && !l.deleted) : null;

  let lead = existing;
  let createdLead = null;
  if (!lead) {
    const seed = draft.newLead || {};
    createdLead = blankLead({
      name: seed.name || draft.leadName || 'Unnamed lead',
      company: seed.company || '',
      phone: seed.phone || '',
      status: 'new',
    }, now);
    lead = createdLead;
  }

  const interaction = blankInteraction({
    lead_id: lead.id,
    kind: draft.kind || 'note',
    direction: draft.direction || 'out',
    outcome: draft.outcome || '',
    summary: draft.summary || '',
    body: draft.body || draft.summary || '',
    occurred_at: draft.occurredAt || now,
  }, now);

  const leadPatch = { updated_at: now };
  if (interaction.kind !== 'note') {
    leadPatch.last_contact_at = Math.max(lead.last_contact_at || 0, interaction.occurred_at);
  }
  if (draft.status) leadPatch.status = draft.status;
  else if (lead.status === 'new' && REACHED.has(interaction.outcome)) leadPatch.status = 'contacted';

  if (draft.nextActionAt) {
    leadPatch.next_action_at = draft.nextActionAt;
    leadPatch.next_action = draft.nextAction || 'Follow up';
  } else if (draft.nextAction) {
    leadPatch.next_action = draft.nextAction;
  } else if (draft.status === 'won' || draft.status === 'lost') {
    leadPatch.next_action = '';
    leadPatch.next_action_at = null;
  }

  if (draft.value && !lead.value) leadPatch.value = draft.value;

  return {
    createdLead,
    lead: { ...lead, ...leadPatch },
    interaction,
  };
}

/** Human labels for the outcome codes stored on interactions. */
export const OUTCOME_LABELS = {
  talked: 'Talked',
  no_answer: 'No answer',
  voicemail: 'Left voicemail',
  callback: 'Callback agreed',
  meeting_booked: 'Meeting booked',
  not_interested: 'Not interested',
  closed_won: 'Closed won',
  wrong_number: 'Wrong number',
  '': '',
};

export const KIND_LABELS = {
  call: 'Call', text: 'Text', email: 'Email', meeting: 'Meeting', note: 'Note',
};
