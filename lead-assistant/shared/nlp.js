/**
 * A dependency-free parser for the things a salesperson types after a call.
 * It is deliberately modest: it catches the common phrasings so the app stays
 * fully usable with no API key, and the AI layer handles everything subtler.
 */
import { zonedParts, zonedTimeToMs, nextWeekday, DAY_MS, HOUR_MS } from './timezone.js';

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

const PART_OF_DAY = {
  morning: 9, afternoon: 14, evening: 17, tonight: 18, night: 18, noon: 12, midday: 12,
};

/** Pulls an explicit clock time out of the text, e.g. "at 2:30pm" or "9am". */
function extractTime(text) {
  const explicit = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (explicit) {
    let hour = Number(explicit[1]) % 12;
    const minute = Number(explicit[2] || 0);
    if (/^p/i.test(explicit[3])) hour += 12;
    return { hour, minute, source: explicit[0] };
  }
  const bare = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (bare) {
    let hour = Number(bare[1]);
    const minute = Number(bare[2] || 0);
    if (hour <= 7) hour += 12; // "at 4" means the afternoon in sales
    if (hour > 23) return null;
    return { hour, minute, source: bare[0] };
  }
  for (const [word, hour] of Object.entries(PART_OF_DAY)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      return { hour, minute: 0, source: word };
    }
  }
  return null;
}

/**
 * Finds a future moment described in `text`. Returns null when the text does
 * not schedule anything.
 */
export function parseWhen(text, { now = Date.now(), timezone = 'UTC' } = {}) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const time = extractTime(lower);
  const hour = time ? time.hour : 9;
  const minute = time ? time.minute : 0;
  const today = zonedParts(now, timezone);
  const onDay = (dayOffset) => zonedTimeToMs(
    { year: today.year, month: today.month, day: today.day + dayOffset, hour, minute },
    timezone,
  );

  // "in 3 days" / "in two weeks" / "in an hour"
  const relative = lower.match(
    /\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(minute|hour|day|week|month)s?\b/,
  );
  if (relative) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = words[relative[1]] ?? Number(relative[1]);
    const unit = relative[2];
    if (Number.isFinite(n)) {
      if (unit === 'minute') return { at: now + n * 60 * 1000, matched: relative[0] };
      if (unit === 'hour') return { at: now + n * HOUR_MS, matched: relative[0] };
      if (unit === 'day') return { at: onDay(n), matched: relative[0] };
      if (unit === 'week') return { at: onDay(n * 7), matched: relative[0] };
      if (unit === 'month') {
        return {
          at: zonedTimeToMs({ year: today.year, month: today.month + n, day: today.day, hour, minute }, timezone),
          matched: relative[0],
        };
      }
    }
  }

  if (/\btomorrow\b/.test(lower)) return { at: onDay(1), matched: 'tomorrow' };
  if (/\bday after tomorrow\b/.test(lower)) return { at: onDay(2), matched: 'day after tomorrow' };
  if (/\b(today|this afternoon|this morning|tonight|later today)\b/.test(lower)) {
    let at = onDay(0);
    if (at <= now) at = now + HOUR_MS;
    return { at, matched: 'today' };
  }

  // "next monday" / "monday" / "this friday"
  const weekday = lower.match(/\b(next\s+|this\s+|on\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
  if (weekday) {
    const index = WEEKDAYS[weekday[2]];
    let at = nextWeekday(now, index, hour, minute, timezone);
    if ((weekday[1] || '').trim() === 'next' && at - now < 7 * DAY_MS) {
      at = nextWeekday(at, index, hour, minute, timezone);
    }
    return { at, matched: weekday[0].trim() };
  }

  if (/\bnext week\b/.test(lower)) return { at: onDay(7), matched: 'next week' };
  if (/\bnext month\b/.test(lower)) {
    return {
      at: zonedTimeToMs({ year: today.year, month: today.month + 1, day: today.day, hour, minute }, timezone),
      matched: 'next month',
    };
  }

  // "march 14" or "14 march"
  const monthFirst = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  const dayFirst = lower.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  const named = monthFirst
    ? { month: MONTHS[monthFirst[1]], day: Number(monthFirst[2]), matched: monthFirst[0] }
    : dayFirst
      ? { month: MONTHS[dayFirst[2]], day: Number(dayFirst[1]), matched: dayFirst[0] }
      : null;
  if (named && named.month) {
    let year = today.year;
    let at = zonedTimeToMs({ year, month: named.month, day: named.day, hour, minute }, timezone);
    if (at < now - DAY_MS) {
      year += 1;
      at = zonedTimeToMs({ year, month: named.month, day: named.day, hour, minute }, timezone);
    }
    return { at, matched: named.matched };
  }

  // Numeric "3/14" or "14/3" is ambiguous worldwide; assume month/day.
  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : today.year;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let at = zonedTimeToMs({ year, month, day, hour, minute }, timezone);
      if (!numeric[3] && at < now - DAY_MS) {
        at = zonedTimeToMs({ year: year + 1, month, day, hour, minute }, timezone);
      }
      return { at, matched: numeric[0] };
    }
  }

  // A bare time with no date means the next time that clock reading happens.
  if (time) {
    let at = onDay(0);
    if (at <= now) at = onDay(1);
    return { at, matched: time.source };
  }

  return null;
}

const OUTCOME_RULES = [
  { outcome: 'no_answer', status: null, patterns: [/\bno answer\b/, /\bdidn'?t (?:pick ?up|answer)\b/, /\bno pick ?up\b/, /\brang out\b/] },
  { outcome: 'voicemail', status: null, patterns: [/\bvoice ?mail\b/, /\bleft a? ?(?:vm|message)\b/, /\bwent to vm\b/] },
  { outcome: 'not_interested', status: 'lost', patterns: [/\bnot interested\b/, /\bnot a fit\b/, /\bpass(?:ed|ing)? on\b/, /\bwent with (?:someone|another)\b/, /\bhard no\b/] },
  { outcome: 'wrong_number', status: null, patterns: [/\bwrong number\b/, /\bbad number\b/, /\bdisconnected\b/] },
  { outcome: 'closed_won', status: 'won', patterns: [/\bsigned\b/, /\bclosed(?: it)?(?: won)?\b/, /\bpaid\b/, /\bsold\b/, /\bbought\b/] },
  { outcome: 'meeting_booked', status: 'hot', patterns: [/\bbooked\b/, /\bdemo\b/, /\bappointment\b/, /\bmeeting (?:set|booked|scheduled)\b/, /\bset up a (?:call|meeting)\b/] },
  { outcome: 'callback', status: 'contacted', patterns: [/\bcall (?:me |him |her |them )?back\b/, /\bcall back\b/, /\bfollow(?:ed)? up\b/, /\breach out\b/, /\bcheck back\b/] },
  { outcome: 'talked', status: 'contacted', patterns: [/\bspoke\b/, /\btalked\b/, /\bgot (?:a hold of|through)\b/, /\bchatted\b/, /\bcalled\b/] },
];

const INTEREST_RULES = [
  { status: 'negotiating', patterns: [/\bsent (?:a )?(?:quote|proposal|contract|pricing)\b/, /\bnegotiat/, /\breviewing the (?:quote|contract|proposal)\b/] },
  { status: 'hot', patterns: [/\bvery interested\b/, /\bready to (?:go|buy|move)\b/, /\bwants? (?:to )?(?:move|start|buy)\b/, /\bhot\b/] },
  { status: 'nurture', patterns: [/\bnot (?:right )?now\b/, /\bnext (?:quarter|year)\b/, /\bcheck back in\b/, /\btoo early\b/, /\bbudget (?:next|later)\b/] },
];

const KIND_RULES = [
  { kind: 'text', patterns: [/\btexted\b/, /\bsms\b/, /\bwhats ?app\b/, /\bmessaged\b/] },
  { kind: 'email', patterns: [/\bemailed\b/, /\bsent (?:an )?email\b/, /\breplied by email\b/] },
  { kind: 'meeting', patterns: [/\bmet with\b/, /\bmeeting\b/, /\bdemo\b/, /\bsat down\b/] },
  { kind: 'call', patterns: [/\bcalled\b/, /\bspoke\b/, /\bphone\b/, /\brang\b/, /\bvoice ?mail\b/] },
];

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'from', 'about', 'call', 'called', 'spoke', 'talked',
  'said', 'told', 'him', 'her', 'them', 'they', 'back', 'just', 'got', 'off',
  'inc', 'llc', 'ltd', 'co', 'company', 'corp', 'a', 'an', 'to', 'at', 'on', 'of',
]);

/**
 * Picks the lead the text is most likely about. Returns null rather than
 * guessing when nothing scores clearly above the noise.
 */
export function matchLead(text, leads = []) {
  const haystack = normalize(text);
  if (!haystack) return null;
  const digits = String(text).replace(/\D/g, '');

  let best = null;
  for (const lead of leads) {
    if (lead.deleted) continue;
    let score = 0;

    const leadDigits = String(lead.phone || '').replace(/\D/g, '');
    if (leadDigits.length >= 7 && digits.length >= 7 && digits.includes(leadDigits.slice(-7))) {
      score += 100;
    }

    for (const field of [lead.name, lead.company]) {
      const tokens = normalize(field).split(' ').filter((t) => t.length > 1 && !STOP_WORDS.has(t));
      if (!tokens.length) continue;
      const full = normalize(field);
      if (full && haystack.includes(full)) score += 40 + full.length;
      for (const token of tokens) {
        if (new RegExp(`\\b${token}\\b`).test(haystack)) score += token.length >= 4 ? 14 : 8;
      }
    }

    if (score > 0 && (!best || score > best.score)) best = { lead, score };
  }

  return best && best.score >= 12 ? best : null;
}

const NOT_A_NAME = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'today', 'tomorrow', 'tonight',
  'him', 'her', 'them', 'they', 'the', 'a', 'an', 'me', 'us', 'it', 'his', 'she',
  'he', 'we', 'i', 'no', 'next', 'last', 'this', 'voicemail', 'vm',
]);

const LEADING_NOT_NAME = new Set([
  'called', 'call', 'calling', 'spoke', 'talked', 'met', 'tried', 'trying', 'left',
  'sent', 'texted', 'emailed', 'rang', 'booked', 'closed', 'followed', 'follow',
  'reached', 'got', 'had', 'have', 'need', 'needs', 'should', 'will', 'just',
  'quick', 'still', 'waiting', 'set', 'setting', 'sold', 'signed', 'missed',
  'picked', 'dropped', 'stopped', 'swung', 'pinged', 'chased', 'confirmed',
  'scheduled', 'checked', 'check', 'update', 'updated', 'note', 'notes',
  'voicemail', 'message', 'messaged', 'new', 'yes', 'maybe', 'not', 'and', 'but',
  'also', 'then', 'after', 'before', 'went', 'saw', 'ran', 'spoke', 'gave',
]);

function looksLikeName(candidate) {
  if (!candidate) return false;
  const words = candidate.trim().split(/\s+/);
  if (!words.length || words.length > 3) return false;
  // A real name is capitalised. The verb before it is matched case-insensitively,
  // so this is what keeps "called him back" from producing a lead named "him".
  return words.every(
    (word) => word.length > 1 && /^[A-Z]/.test(word) && !NOT_A_NAME.has(word.toLowerCase()),
  );
}

/**
 * Pulls a probable name, company and phone number out of a note about someone
 * who is not on the list yet. Conservative: it would rather return nothing than
 * invent a lead called "Thursday".
 */
export function guessContact(text) {
  const raw = String(text || '');
  const out = { name: '', company: '', phone: '' };

  // The verb is matched without regard to case, but the name that follows must
  // be capitalised -- matched separately so a trailing lowercase word such as
  // "at" is never pulled into the name.
  const lead = /\b(?:spoke (?:to|with)|talked (?:to|with)|met (?:with\s)?|call(?:ed|ing)?|rang|text(?:ed)?|email(?:ed)?|reached out to|got off (?:the phone )?with|with|from|for)\s+/i.exec(raw);
  if (lead) {
    const after = raw.slice(lead.index + lead[0].length);
    const nameMatch = after.match(/^([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})/);
    if (nameMatch && looksLikeName(nameMatch[1])) out.name = nameMatch[1].trim();
  }

  if (!out.name) {
    // "Priya Raman at Lakeside wants a quote" -- the name opens the sentence.
    const opener = raw.trim().match(/^([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})/);
    if (opener && looksLikeName(opener[1])) {
      const firstWord = opener[1].split(/\s+/)[0].toLowerCase();
      if (!LEADING_NOT_NAME.has(firstWord)) out.name = opener[1].trim();
    }
  }

  const companyMatch = raw.match(/\b[Aa]t\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,2})/);
  if (companyMatch && looksLikeName(companyMatch[1])) out.company = companyMatch[1].trim();

  const phoneMatch = raw.match(/(\+?\d[\d\s().-]{6,}\d)/);
  if (phoneMatch) {
    const digits = phoneMatch[1].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) out.phone = phoneMatch[1].trim();
  }

  return out;
}

/**
 * Turns "just got off with Mike at Acme, wants a callback Thursday" into the
 * fields the app stores. Every field is a suggestion the person can edit.
 */
export function parseCallLog(text, { now = Date.now(), timezone = 'UTC', leads = [] } = {}) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();

  let kind = 'note';
  for (const rule of KIND_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) { kind = rule.kind; break; }
  }

  let outcome = '';
  let status = null;
  for (const rule of OUTCOME_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      outcome = rule.outcome;
      status = rule.status;
      break;
    }
  }
  for (const rule of INTEREST_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) { status = rule.status; break; }
  }
  if (outcome && kind === 'note') kind = 'call';

  const when = parseWhen(raw, { now, timezone });
  const match = matchLead(raw, leads);

  // Only treat a parsed date as a callback when the sentence sounds like one.
  // "try again tomorrow" and "left a vm, tuesday" both schedule something;
  // "he is out of the office tomorrow" does not.
  const FOLLOW_UP_VERBS = /\b(call|calling|follow|following|reach|reaching|check|checking|touch|text|texting|email|emailing|meet|meeting|circle|try|trying|again|ring|ping|chase|revisit|reconnect|swing|stop by|get back|come back|talk)\b/;
  const schedulesFollowUp = when != null && (
    FOLLOW_UP_VERBS.test(lower)
    || outcome === 'callback'
    || outcome === 'no_answer'
    || outcome === 'voicemail'
    || outcome === 'meeting_booked'
  );

  const guessed = match ? null : guessContact(raw);

  return {
    leadId: match ? match.lead.id : null,
    leadName: match ? match.lead.name : (guessed.name || null),
    newLead: match ? null : guessed,
    confidence: match ? Math.min(1, match.score / 60) : 0,
    kind,
    direction: /\b(?:called|texted|emailed|reached out|rang)\b/.test(lower) ? 'out' : 'in',
    outcome,
    status,
    summary: raw.length > 140 ? `${raw.slice(0, 137)}...` : raw,
    body: raw,
    occurredAt: now,
    nextActionAt: schedulesFollowUp ? when.at : null,
    nextAction: schedulesFollowUp ? suggestAction(outcome, lower) : '',
    source: 'rules',
  };
}

function suggestAction(outcome, lower) {
  if (outcome === 'voicemail' || outcome === 'no_answer') return 'Try again';
  if (outcome === 'meeting_booked') return 'Confirm the meeting';
  if (/\bquote|proposal|pricing\b/.test(lower)) return 'Follow up on the quote';
  if (/\bpartner|spouse|boss|wife|husband|team\b/.test(lower)) return 'Check after they talk it over';
  return 'Call back';
}

export { extractTime };
