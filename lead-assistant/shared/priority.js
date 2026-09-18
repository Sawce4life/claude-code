import { DAY_MS, HOUR_MS, startOfDay, endOfDay, daysBetween, describeTime } from './timezone.js';

/** Pipeline stages, ordered from coldest to warmest. */
export const STATUSES = ['new', 'contacted', 'nurture', 'hot', 'negotiating', 'won', 'lost'];

export const STATUS_LABELS = {
  new: 'New', contacted: 'Contacted', nurture: 'Nurture',
  hot: 'Hot', negotiating: 'Negotiating', won: 'Won', lost: 'Lost',
};

/** How many days may pass before a lead in this stage is overdue for a touch. */
const CADENCE_DAYS = {
  new: 0, contacted: 3, hot: 2, negotiating: 2, nurture: 21, won: 90, lost: 365,
};

const STATUS_BONUS = {
  negotiating: 80, hot: 60, new: 30, contacted: 20, nurture: -20, won: -500, lost: -1000,
};

/** Buckets in the order they are worked through. */
export const BUCKETS = ['overdue', 'today', 'new', 'due', 'upcoming', 'resting'];

const BUCKET_LABELS = {
  overdue: 'Overdue', today: 'Scheduled today', new: 'Never contacted',
  due: 'Going cold', upcoming: 'Coming up', resting: 'Recently touched',
};

function lastContactOf(lead, interactionsByLead) {
  const list = interactionsByLead.get(lead.id) || [];
  let latest = lead.last_contact_at || 0;
  for (const it of list) {
    if (it.deleted) continue;
    if (it.kind === 'note') continue; // a note to self is not a touch
    if ((it.occurred_at || 0) > latest) latest = it.occurred_at || 0;
  }
  return latest || null;
}

/**
 * Scores one lead. Pure and deterministic: the same inputs always produce the
 * same score, which is what makes the list trustworthy day to day.
 */
export function scoreLead(lead, context) {
  const { now, timezone, interactionsByLead, openTasksByLead } = context;
  const todayStart = startOfDay(now, timezone);
  const todayEnd = endOfDay(now, timezone);

  const lastContact = lastContactOf(lead, interactionsByLead);
  const daysSince = lastContact == null ? null : daysBetween(lastContact, now, timezone);
  const cadence = CADENCE_DAYS[lead.status] ?? 7;
  const due = lead.next_action_at || null;

  let bucket;
  let score;
  let reason;

  if (due != null && due < todayStart) {
    const daysLate = Math.max(1, daysBetween(due, now, timezone));
    bucket = 'overdue';
    score = 1000 + Math.min(daysLate, 30) * 12;
    reason = lead.next_action
      ? `${lead.next_action} -- was due ${daysLate} day${daysLate === 1 ? '' : 's'} ago`
      : `Follow-up was due ${daysLate} day${daysLate === 1 ? '' : 's'} ago`;
  } else if (due != null && due <= todayEnd) {
    bucket = 'today';
    // Earlier in the day sorts first.
    score = 800 + Math.max(0, (todayEnd - due) / HOUR_MS);
    reason = lead.next_action
      ? `${lead.next_action} -- ${describeTime(due, timezone, now)}`
      : `Scheduled for ${describeTime(due, timezone, now)}`;
  } else if (lastContact == null) {
    const ageDays = lead.created_at ? Math.max(0, daysBetween(lead.created_at, now, timezone)) : 0;
    bucket = 'new';
    // Speed matters most on fresh leads, but an untouched old one still nags.
    score = 620 + Math.min(ageDays, 21) * 6;
    reason = ageDays === 0
      ? 'New lead -- never contacted'
      : `Never contacted, ${ageDays} day${ageDays === 1 ? '' : 's'} old`;
  } else if (due == null && daysSince >= cadence) {
    bucket = 'due';
    score = 400 + Math.min(daysSince - cadence, 60) * 9;
    reason = `No contact in ${daysSince} day${daysSince === 1 ? '' : 's'}`;
  } else if (due != null) {
    const daysOut = Math.max(1, daysBetween(now, due, timezone));
    bucket = 'upcoming';
    score = 120 - Math.min(daysOut, 60);
    reason = `${lead.next_action || 'Follow-up'} -- ${describeTime(due, timezone, now)}`;
  } else {
    bucket = 'resting';
    score = 80 - Math.min(cadence - daysSince, 30);
    reason = `Spoke ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}`;
  }

  score += STATUS_BONUS[lead.status] ?? 0;
  // A bigger deal is worth calling first, but value never outranks a promise.
  score += Math.min(Number(lead.value) || 0, 100000) / 2000;

  const openTasks = (openTasksByLead.get(lead.id) || []).filter(
    (t) => !t.deleted && !t.done_at,
  );
  if (openTasks.some((t) => t.due_at != null && t.due_at < todayEnd)) score += 60;

  return {
    leadId: lead.id,
    bucket,
    bucketLabel: BUCKET_LABELS[bucket],
    score: Math.round(score * 100) / 100,
    reason,
    lastContactAt: lastContact,
    daysSinceContact: daysSince,
    dueAt: due,
    openTasks: openTasks.length,
  };
}

function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

/**
 * Ranks the whole book of business. Returns entries sorted by urgency, each
 * carrying the lead plus a plain-English reason it is where it is.
 */
export function rankLeads({
  leads = [],
  interactions = [],
  tasks = [],
  now = Date.now(),
  timezone = 'UTC',
  includeResting = true,
} = {}) {
  const context = {
    now,
    timezone,
    interactionsByLead: indexBy(interactions, 'lead_id'),
    openTasksByLead: indexBy(tasks, 'lead_id'),
  };

  const ranked = [];
  for (const lead of leads) {
    if (lead.deleted) continue;
    if (lead.do_not_call) continue;
    if (lead.status === 'won' || lead.status === 'lost') continue;
    const entry = scoreLead(lead, context);
    if (!includeResting && (entry.bucket === 'resting' || entry.bucket === 'upcoming')) continue;
    ranked.push({ ...entry, lead });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, predictable tie-break so the list does not shuffle on reload.
    const an = (a.lead.name || '').toLowerCase();
    const bn = (b.lead.name || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.leadId < b.leadId ? -1 : 1;
  });

  return ranked;
}

/** The short list for right now: everything actually owed today. */
export function callListForToday(args) {
  const ranked = rankLeads(args);
  return ranked.filter((e) => ['overdue', 'today', 'new', 'due'].includes(e.bucket));
}

/** Counts per bucket, for the header on the Today screen. */
export function summarize(ranked) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const entry of ranked) counts[entry.bucket] = (counts[entry.bucket] || 0) + 1;
  return counts;
}

export { CADENCE_DAYS, DAY_MS };
