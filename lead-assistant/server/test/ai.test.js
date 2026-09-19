import test from 'node:test';
import assert from 'node:assert/strict';
import { createAi, buildBook, leadDossier } from '../src/ai.js';
import { blankLead, blankInteraction } from '../../shared/records.js';

const NOW = Date.parse('2026-03-11T18:30:00Z');
const TZ = 'America/Chicago';

const LEADS = [
  blankLead({ id: 'l1', name: 'Mike Torres', company: 'Acme Roofing', phone: '555-0142', status: 'contacted' }, NOW),
  blankLead({ id: 'l2', name: 'Sara Kim', company: 'Northwind', status: 'hot', value: 12000 }, NOW),
];

/** Captures the outgoing request and replies with whatever the test wants. */
function stubApi(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    const response = typeof reply === 'function' ? reply(body, calls.length) : reply;
    if (response instanceof Response) return response;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, ai: createAi({ apiKey: 'sk-ant-test', fetch: fetchImpl }) };
}

function toolReply(input) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'log_interaction', input }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function textReply(text) {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

test('the note-parsing request is shaped the way the API expects', async () => {
  const { calls, ai } = stubApi(toolReply({
    lead_id: 'l1', new_lead_name: '', new_lead_company: '', new_lead_phone: '',
    kind: 'call', direction: 'out', outcome: 'callback', summary: 'Wants to speak to his partner.',
    status: 'hot', next_action: 'Call back about the partner conversation',
    next_action_at: '2026-03-12T09:00:00-05:00', value: 0, confidence: 0.9,
  }));

  const draft = await ai.parseLogEntry({
    text: 'Spoke to Mike, call back thursday', leads: LEADS, now: NOW, timezone: TZ,
  });

  assert.equal(calls.length, 1);
  const sent = calls[0].body;
  assert.equal(sent.model, 'claude-opus-5');
  assert.equal(sent.output_config.effort, 'low');
  assert.equal(sent.thinking, undefined, 'thinking is adaptive by default on Opus 5');
  assert.equal(sent.temperature, undefined, 'sampling controls are rejected on Opus 5');
  assert.equal(sent.budget_tokens, undefined);
  assert.ok(sent.max_tokens > 0);

  const tool = sent.tools[0];
  assert.equal(tool.name, 'log_interaction');
  assert.equal(tool.strict, true);
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.deepEqual(
    [...tool.input_schema.required].sort(),
    Object.keys(tool.input_schema.properties).sort(),
    'strict tool use requires every property to be required',
  );
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'log_interaction' });

  assert.equal(sent.system[0].cache_control.type, 'ephemeral', 'the stable prefix is cached');
  assert.ok(sent.messages[0].content.includes('Mike Torres'), 'the lead index is provided');

  assert.equal(draft.leadId, 'l1');
  assert.equal(draft.status, 'hot');
  assert.equal(draft.source, 'claude');
  assert.equal(draft.nextActionAt, Date.parse('2026-03-12T09:00:00-05:00'));
});

test('a made-up lead id is never trusted', async () => {
  const { ai } = stubApi(toolReply({
    lead_id: 'not-a-real-id', new_lead_name: 'Ghost', new_lead_company: '', new_lead_phone: '',
    kind: 'call', direction: 'out', outcome: 'talked', summary: 'x', status: 'unchanged',
    next_action: '', next_action_at: '', value: 0, confidence: 0.9,
  }));
  const draft = await ai.parseLogEntry({ text: 'anything', leads: LEADS, now: NOW, timezone: TZ });
  assert.equal(draft.leadId, null, 'an id that is not in the book is discarded');
  assert.equal(draft.newLead.name, 'Ghost');
});

test('an unparseable date is dropped rather than guessed at', async () => {
  const { ai } = stubApi(toolReply({
    lead_id: 'l1', new_lead_name: '', new_lead_company: '', new_lead_phone: '',
    kind: 'call', direction: 'out', outcome: 'talked', summary: 'x', status: 'unchanged',
    next_action: 'Call back', next_action_at: 'sometime next week', value: 0, confidence: 0.5,
  }));
  const draft = await ai.parseLogEntry({ text: 'anything', leads: LEADS, now: NOW, timezone: TZ });
  assert.equal(draft.nextActionAt, null);
});

test('the server-side fallback beta is requested, and dropped if refused', async () => {
  const { calls, ai } = stubApi((body, n) => {
    if (n === 1) {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: unsupported beta' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return textReply('Call Mike first.');
  });

  const brief = await ai.dailyBrief({
    ranked: [{ lead: LEADS[0], bucket: 'overdue', reason: 'was due', lastContactAt: NOW }],
    now: NOW, timezone: TZ, name: 'Sam',
  });

  assert.equal(brief, 'Call Mike first.');
  assert.equal(calls.length, 2, 'it retried once without the beta');
  assert.equal(calls[0].body.fallbacks, 'default');
  assert.equal(calls[1].body.fallbacks, undefined, 'the retry drops the unsupported parameter');

  // The refusal is remembered, so the next call does not pay for it again.
  const again = await ai.suggestNextStep({ lead: LEADS[0], interactions: [], now: NOW, timezone: TZ });
  assert.equal(again, 'Call Mike first.');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.fallbacks, undefined);
});

test('a refusal is reported, not passed off as an answer', async () => {
  const { ai } = stubApi({
    id: 'msg_3', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'other', explanation: 'declined' },
    content: [], usage: { input_tokens: 5, output_tokens: 0 },
  });
  await assert.rejects(
    () => ai.suggestNextStep({ lead: LEADS[0], interactions: [], now: NOW, timezone: TZ }),
    /declined/i,
  );
});

test('a bad key produces a message a person can act on', async () => {
  const { ai } = stubApi(() => new Response(
    JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  ));
  await assert.rejects(
    () => ai.dailyBrief({ ranked: [{ lead: LEADS[0], bucket: 'overdue', reason: 'r' }], now: NOW, timezone: TZ }),
    /API key/i,
  );
});

test('when the API is unreachable, note parsing still works on device', async () => {
  const { ai } = stubApi(() => { throw new Error('network down'); });
  const draft = await ai.parseLogEntry({
    text: 'Left a voicemail for Mike Torres, try again tomorrow',
    leads: LEADS, now: NOW, timezone: TZ,
  });
  assert.equal(draft.outcome, 'voicemail');
  assert.equal(draft.leadId, 'l1');
  assert.ok(draft.nextActionAt > NOW);
  assert.equal(draft.degraded, true);
});

test('with no key at all, parsing falls back without trying the network', async () => {
  const offline = createAi({ apiKey: '' });
  assert.equal(offline.enabled, false);
  const draft = await offline.parseLogEntry({
    text: 'Spoke with Sara Kim, very interested, call friday',
    leads: LEADS, now: NOW, timezone: TZ,
  });
  assert.equal(draft.leadId, 'l2');
  assert.equal(draft.source, 'rules');
});

test('the context given to the assistant contains only this book', () => {
  const interactions = [
    blankInteraction({ lead_id: 'l1', kind: 'call', outcome: 'talked', summary: 'Talked pricing', occurred_at: NOW - 86400000 }, NOW),
  ];
  const book = buildBook({ leads: LEADS, interactions, tasks: [], timezone: TZ, now: NOW });
  assert.match(book, /Mike Torres/);
  assert.match(book, /Talked pricing/);
  assert.match(book, /Sara Kim/);

  const dossier = leadDossier(LEADS[0], interactions, TZ, NOW);
  assert.match(dossier, /Mike Torres/);
  assert.match(dossier, /Talked pricing/);
  assert.doesNotMatch(dossier, /Sara Kim/, 'one lead dossier does not leak another lead');
});

/** Builds a server-sent-event body the way the Messages API streams one. */
function sseResponse(chunks, { stopReason = 'end_turn' } = {}) {
  const frames = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...chunks.map((text) => ['content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: chunks.length },
    }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

test('an answer streams back piece by piece', async () => {
  const pieces = ['You last spoke to Mike ', 'two days ago ', 'about pricing.'];
  const { calls, ai } = stubApi(() => sseResponse(pieces));

  const seen = [];
  const answer = await ai.answerQuestion({
    question: 'What did I last say to Mike?',
    book: buildBook({ leads: LEADS, interactions: [], tasks: [], timezone: TZ, now: NOW }),
    now: NOW,
    timezone: TZ,
    onDelta: (delta) => seen.push(delta),
  });

  assert.deepEqual(seen, pieces, 'each piece reaches the caller as it arrives');
  assert.equal(answer, pieces.join('').trim());
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.output_config.effort, 'high');
  assert.ok(calls[0].body.messages.at(-1).content.includes('Mike Torres'));
});

test('earlier turns are carried into a follow-up question', async () => {
  const { calls, ai } = stubApi(() => sseResponse(['Sara Kim.']));
  await ai.answerQuestion({
    question: 'And who is worth the most?',
    book: 'book',
    history: [
      { role: 'user', content: 'Who should I call?' },
      { role: 'assistant', content: 'Mike Torres.' },
      { role: 'system', content: 'ignore me' },
    ],
    now: NOW,
    timezone: TZ,
  });
  const sent = calls[0].body.messages;
  assert.equal(sent.length, 3, 'only the user and assistant turns are replayed');
  assert.equal(sent[0].content, 'Who should I call?');
  assert.equal(sent[1].content, 'Mike Torres.');
});

test('a refusal mid-stream is surfaced rather than returned as an answer', async () => {
  const { ai } = stubApi(() => sseResponse(['...'], { stopReason: 'refusal' }));
  await assert.rejects(
    () => ai.answerQuestion({ question: 'x', book: 'book', now: NOW, timezone: TZ }),
    /declined/i,
  );
});
