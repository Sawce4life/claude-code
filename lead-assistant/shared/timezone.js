/**
 * Timezone helpers built on Intl, so the app can say "today" and "Thursday
 * 9am" the way the person holding the phone means it -- not the way the server
 * happens to be configured.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Calendar fields for `ms` as seen in `timeZone`. */
export function zonedParts(ms, timeZone = 'UTC') {
  const tz = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const parts = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** How far `timeZone` is ahead of UTC at instant `ms`, in milliseconds. */
export function zoneOffset(ms, timeZone = 'UTC') {
  const p = zonedParts(ms, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the given local wall-clock time occurs in `timeZone`.
 * Runs the offset lookup twice so daylight-saving transitions land correctly.
 */
export function zonedTimeToMs(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone = 'UTC',
) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive - zoneOffset(naive, timeZone);
  const refined = naive - zoneOffset(guess, timeZone);
  if (refined !== guess) guess = refined;
  return guess;
}

export function startOfDay(ms, timeZone = 'UTC') {
  const p = zonedParts(ms, timeZone);
  return zonedTimeToMs({ year: p.year, month: p.month, day: p.day }, timeZone);
}

export function endOfDay(ms, timeZone = 'UTC') {
  return startOfDay(ms + DAY_MS, timeZone) - 1;
}

/** Adds whole days in local terms, keeping the same wall-clock time. */
export function addDays(ms, days, timeZone = 'UTC') {
  const p = zonedParts(ms, timeZone);
  return zonedTimeToMs(
    { year: p.year, month: p.month, day: p.day + days, hour: p.hour, minute: p.minute, second: p.second },
    timeZone,
  );
}

/** Whole local days between two instants (positive when `b` is later). */
export function daysBetween(a, b, timeZone = 'UTC') {
  return Math.round((startOfDay(b, timeZone) - startOfDay(a, timeZone)) / DAY_MS);
}

export function isSameDay(a, b, timeZone = 'UTC') {
  return startOfDay(a, timeZone) === startOfDay(b, timeZone);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function weekdayIndex(ms, timeZone = 'UTC') {
  return WEEKDAY_INDEX[zonedParts(ms, timeZone).weekday] ?? 0;
}

/**
 * The next occurrence of a weekday (0=Sunday) at a given local hour.
 * Always lands strictly in the future relative to `from`.
 */
export function nextWeekday(from, targetIndex, hour, minute, timeZone = 'UTC') {
  const current = weekdayIndex(from, timeZone);
  let delta = (targetIndex - current + 7) % 7;
  const p = zonedParts(from, timeZone);
  let candidate = zonedTimeToMs(
    { year: p.year, month: p.month, day: p.day + delta, hour, minute },
    timeZone,
  );
  if (candidate <= from) {
    delta += 7;
    candidate = zonedTimeToMs(
      { year: p.year, month: p.month, day: p.day + delta, hour, minute },
      timeZone,
    );
  }
  return candidate;
}

/** Short human label such as "Today 2:30 PM" or "Thu, Mar 14". */
export function describeTime(ms, timeZone = 'UTC', now = Date.now()) {
  if (ms == null) return '';
  const days = daysBetween(now, ms, timeZone);
  const p = zonedParts(ms, timeZone);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  const clock = `${hour12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) return `${p.weekday} ${clock}`;
  if (days < -1 && days > -7) return `${Math.abs(days)} days ago`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.weekday}, ${months[p.month - 1]} ${p.day}`;
}
