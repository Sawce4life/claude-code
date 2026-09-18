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

/** Outcomes where the phone rang out: an attempt, but not a conversation. */
const NOT_REACHED = new Set(['no_answer', 'voicemail', 'wrong_number']);

/**
 * Separates "I tried" from "I got through". Three voicemails in a row is not
 * the same as a conversation three days ago, and the list has to know that.
 */
function contactHistory(lead, interactionsByLead) {
  const list = interactionsByLead.get(lead.id) || [];
  let lastReached = lead.last_contact_at || 0;
  let lastAttempt = lead.last_contact_at || 0;

  for (const item of list) {
    if (item.deleted) continue;
    if (item.kind === 'note') continue; // a note to self is not a touch
    const at = item.occurred_at || 0;
    if (at > lastAttempt) lastAttempt = at;
    if (!NOT_REACHED.has(item.outcome) && at > lastReached) lastReached = at;
  }

  let missedTries = 0;
  for (const item of list) {
    if (item.deleted || item.kind === 'note') continue;
    if (NOT_REACHED.has(item.outcome) && (item.occurred_at || 0) > lastReached) missedTries += 1;
  }

  return {
    lastReached: lastReached || null,
    lastAttempt: lastAttempt || null,
    missedTries,
  };
}

/**
 * Scores one lead. Pure and deterministic: the same inputs always produce the
 * same score, which is what makes the list trustworthy day to day.
 */
export function scoreLead(lead, context) {
  const { now, timezone, interactionsByLead, openTasksByLead } = context;
  const todayStart = startOfDay(now, timezone);
  const todayEnd = endOfDay(now, timezone);

  const { lastReached, lastAttempt, missedTries } = contactHistory(lead, interactionsByLead);
  const daysSinceReached = lastReached == null ? null : daysBetween(lastReached, now, timezone);
  const daysSinceAttempt = lastAttempt == null ? null : daysBetween(lastAttempt, now, timezone);
  const cadence = CADENCE_DAYS[lead.status] ?? 7;
  const due = lead.next_action_at || null;
  const triedToday = daysSinceAttempt === 0;

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
  } else if (due != null) {
    const daysOut = Math.max(1, daysBetween(now, due, timezone));
    bucket = 'upcoming';
    score = 120 - Math.min(daysOut, 60);
    reason = `${lead.next_action || 'Follow-up'} -- ${describeTime(due, timezone, now)}`;
  } else if (lastAttempt == null) {
    const ageDays = lead.created_at ? Math.max(0, daysBetween(lead.created_at, now, timezone)) : 0;
    bucket = 'new';
    // Speed matters most on fresh leads, but an untouched old one still nags.
    score = 620 + Math.min(ageDays, 21) * 6;
    reason = ageDays === 0
      ? 'New lead -- never contacted'
      : `Never contacted, ${ageDays} day${ageDays === 1 ? '' : 's'} old`;
  } else if (lastReached == null) {
    // Tried, never got through. Worth another go tomorrow, not in an hour.
    if (triedToday) {
      bucket = 'resting';
      score = 90;
      reason = missedTries > 1
        ? `Tried again today -- ${missedTries} attempts, still no answer`
        : 'Tried today, no answer yet';
    } else {
      bucket = 'due';
      score = 520 + Math.min(missedTries, 6) * 6 + Math.min(daysSinceAttempt - 1, 30) * 8;
      reason = `${missedTries || 1} attempt${missedTries === 1 ? '' : 's'}, never got through`;
    }
  } else if (daysSinceReached >= cadence && !triedToday) {
    bucket = 'due';
    score = 400 + Math.min(daysSinceReached - cadence, 60) * 9;
    reason = `No contact in ${daysSinceReached} day${daysSinceReached === 1 ? '' : 's'}`;
  } else {
    bucket = 'resting';
    score = 80 - Math.min(Math.max(cadence - daysSinceReached, 0), 30);
    reason = daysSinceReached === 0
      ? 'Spoke today'
      : `Spoke ${daysSinceReached} day${daysSinceReached === 1 ? '' : 's'} ago`;
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
    lastContactAt: lastReached,
    lastAttemptAt: lastAttempt,
    missedTries,
    daysSinceContact: daysSinceReached,
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
