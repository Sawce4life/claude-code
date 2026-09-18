import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, parseCallLog, matchLead, guessContact } from '../../shared/nlp.js';
import { zonedParts, startOfDay, daysBetween, DAY_MS } from '../../shared/timezone.js';
import { blankLead, draftToRecords } from '../../shared/records.js';

const TZ = 'America/Chicago';
// Wednesday 11 March 2026, 1:30pm in Chicago.
const NOW = Date.parse('2026-03-11T18:30:00Z');
const ctx = { now: NOW, timezone: TZ };

function local(ms) {
  return zonedParts(ms, TZ);
}

test('"tomorrow" lands on the next local day at a sensible hour', () => {
  const result = parseWhen('call back tomorrow', ctx);
  assert.equal(daysBetween(NOW, result.at, TZ), 1);
  assert.equal(local(result.at).hour, 9);
});

test('a named weekday resolves to the next one, and "next" skips a week', () => {
  const thursday = parseWhen('follow up thursday', ctx);
  assert.equal(local(thursday.at).weekday, 'Thu');
  assert.equal(daysBetween(NOW, thursday.at, TZ), 1);

  const nextThursday = parseWhen('follow up next thursday', ctx);
  assert.equal(local(nextThursday.at).weekday, 'Thu');
  assert.equal(daysBetween(NOW, nextThursday.at, TZ), 8);
});

test('times of day are understood, in words and on the clock', () => {
  assert.equal(local(parseWhen('thursday morning', ctx).at).hour, 9);
  assert.equal(local(parseWhen('thursday afternoon', ctx).at).hour, 14);
  assert.equal(local(parseWhen('call at 2:30pm tomorrow', ctx).at).hour, 14);
  assert.equal(local(parseWhen('call at 2:30pm tomorrow', ctx).at).minute, 30);
  assert.equal(local(parseWhen('monday at 8am', ctx).at).hour, 8);
  // A bare "at 4" in sales means the afternoon.
  assert.equal(local(parseWhen('tomorrow at 4', ctx).at).hour, 16);
});

test('relative spans in days, weeks and months', () => {
  assert.equal(daysBetween(NOW, parseWhen('in 3 days', ctx).at, TZ), 3);
  assert.equal(daysBetween(NOW, parseWhen('in two weeks', ctx).at, TZ), 14);
  assert.equal(local(parseWhen('in a month', ctx).at).month, 4);
  const hour = parseWhen('call back in an hour', ctx);
  assert.equal(Math.round((hour.at - NOW) / 3600000), 1);
});

test('a calendar date rolls to next year once it has passed', () => {
  const upcoming = parseWhen('meeting on march 20', ctx);
  assert.equal(local(upcoming.at).year, 2026);
  assert.equal(local(upcoming.at).month, 3);
  assert.equal(local(upcoming.at).day, 20);

  const passed = parseWhen('meeting on january 5', ctx);
  assert.equal(local(passed.at).year, 2027, 'a date already gone means next year');
});

test('text with no date returns nothing rather than guessing', () => {
  assert.equal(parseWhen('left a voicemail', ctx), null);
  assert.equal(parseWhen('', ctx), null);
});

test('every parsed follow-up is in the future', () => {
  const phrases = [
    'call back tomorrow', 'thursday', 'next monday at 9am', 'in 2 days',
    'in an hour', 'next week', 'march 20', 'wednesday morning', 'friday at 4',
  ];
  for (const phrase of phrases) {
    const result = parseWhen(phrase, ctx);
    assert.ok(result, `"${phrase}" should parse`);
    assert.ok(result.at > NOW, `"${phrase}" resolved to the past`);
  }
});

test('a call note becomes structured fields', () => {
  const leads = [
    blankLead({ id: 'l1', name: 'Mike Torres', company: 'Acme Roofing', phone: '555-0142' }, NOW),
    blankLead({ id: 'l2', name: 'Sara Kim', company: 'Northwind' }, NOW),
  ];
  const draft = parseCallLog(
    'Just got off the phone with Mike at Acme, very interested but wants to talk to his partner. Call back Thursday morning.',
    { ...ctx, leads },
  );

  assert.equal(draft.leadId, 'l1');
  assert.equal(draft.kind, 'call');
  assert.equal(draft.status, 'hot');
  assert.ok(draft.nextActionAt > NOW);
  assert.equal(local(draft.nextActionAt).weekday, 'Thu');
  assert.equal(local(draft.nextActionAt).hour, 9);
});

test('outcomes are read from ordinary phrasing', () => {
  const cases = [
    ['no answer, tried twice', 'no_answer'],
    ['left a vm', 'voicemail'],
    ['said they are not interested', 'not_interested'],
    ['she signed the contract', 'closed_won'],
    ['booked a demo for next tuesday', 'meeting_booked'],
    ['wrong number', 'wrong_number'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseCallLog(text, ctx).outcome, expected, `"${text}"`);
  }
});

test('a note that only mentions a date does not schedule a callback', () => {
  const draft = parseCallLog('he mentioned he was out of the office tomorrow', ctx);
  assert.equal(draft.nextActionAt, null);
});

test('lead matching prefers a phone number over a loose name', () => {
  const leads = [
    blankLead({ id: 'l1', name: 'Mike Torres', phone: '(555) 019-2837' }, NOW),
    blankLead({ id: 'l2', name: 'Mike Anderson' }, NOW),
  ];
  assert.equal(matchLead('called 555-019-2837 back', leads).lead.id, 'l1');
  assert.equal(matchLead('spoke to Mike Anderson', leads).lead.id, 'l2');
  assert.equal(matchLead('spoke to somebody entirely new', leads), null);
});

test('a draft turns into the exact rows that get saved', () => {
  const existing = blankLead({ id: 'l1', name: 'Mike Torres', status: 'new' }, NOW);
  const draft = parseCallLog('Spoke with Mike Torres, very interested. Call back friday.', {
    ...ctx, leads: [existing],
  });
  const { createdLead, lead, interaction } = draftToRecords(draft, { leads: [existing], now: NOW });

  assert.equal(createdLead, null, 'an existing lead is reused');
  assert.equal(interaction.lead_id, 'l1');
  assert.equal(lead.status, 'hot');
  assert.equal(lead.last_contact_at, NOW);
  assert.ok(lead.next_action_at > NOW);
  assert.ok(lead.next_action.length > 0);
});

test('a note about somebody new creates that lead', () => {
  const draft = parseCallLog('Called Priya at Lakeside Dental, wants pricing', { ...ctx, leads: [] });
  const { createdLead, interaction } = draftToRecords(draft, { leads: [], now: NOW });
  assert.ok(createdLead, 'an unknown name becomes a new lead');
  assert.equal(interaction.lead_id, createdLead.id);
});

test('daylight saving does not shift a scheduled callback', () => {
  // US clocks move forward on 8 March 2026; schedule across that boundary.
  const before = Date.parse('2026-03-05T15:00:00Z');
  const result = parseWhen('call back in 5 days at 9am', { now: before, timezone: TZ });
  const parts = zonedParts(result.at, TZ);
  assert.equal(parts.hour, 9, 'still 9am local after the clocks change');
  assert.equal(parts.day, 10);
});

test('local midnight is a real instant in every zone tested', () => {
  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'Europe/London']) {
    const start = startOfDay(NOW, tz);
    assert.equal(zonedParts(start, tz).hour, 0, `${tz} midnight`);
    assert.ok(NOW - start < DAY_MS && NOW >= start, `${tz} contains now`);
  }
});

test('a new person name, company and number are pulled out of the note', () => {
  const guess = guessContact(
    'Just got off the phone with Mike Torres at Acme Roofing, 555-0142. Wants pricing.',
  );
  assert.equal(guess.name, 'Mike Torres');
  assert.equal(guess.company, 'Acme Roofing');
  assert.equal(guess.phone, '555-0142');
});

test('a weekday is never mistaken for a person', () => {
  assert.equal(guessContact('Call back Thursday morning').name, '');
  assert.equal(guessContact('spoke to him again today').name, '');
  assert.equal(guessContact('left a voicemail').name, '');
});

test('an unknown caller becomes a named lead, not "Unnamed lead"', () => {
  const draft = parseCallLog(
    'Called Priya Raman at Lakeside Dental on 555-0188, she wants a quote next week.',
    { ...ctx, leads: [] },
  );
  const { createdLead } = draftToRecords(draft, { leads: [], now: NOW });
  assert.equal(createdLead.name, 'Priya Raman');
  assert.equal(createdLead.company, 'Lakeside Dental');
  assert.ok(createdLead.phone.includes('555-0188'));
});

test('a name is found wherever the sentence puts it', () => {
  assert.equal(guessContact('Left a voicemail for Dana Whitfield 555-0199').name, 'Dana Whitfield');
  assert.equal(guessContact('Priya Raman at Lakeside Dental wants a quote').name, 'Priya Raman');
  assert.equal(guessContact('Spoke with Mike Torres at Acme Roofing').name, 'Mike Torres');
  assert.equal(guessContact('Dana said she will call me back').name, 'Dana');
});

test('a sentence that opens with a verb never invents a lead', () => {
  for (const text of [
    'Called back Thursday as promised',
    'No answer on the Johnson job',
    'Sent the proposal over',
    'Tried again, still nothing',
    'Left a message',
  ]) {
    assert.equal(guessContact(text).name, '', `"${text}" should not yield a name`);
  }
});
