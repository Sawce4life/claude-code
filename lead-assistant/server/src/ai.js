import Anthropic from '@anthropic-ai/sdk';
import { describeTime, zonedParts } from '../../shared/timezone.js';
import { STATUS_LABELS } from '../../shared/priority.js';
import { parseCallLog } from '../../shared/nlp.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

const ASSISTANT_ROLE = `You are the assistant to a salesperson. You keep track of their leads the way a sharp human assistant would: you remember who they spoke to, what was said, what was promised, and when to call back.

How you work:
- You are given the salesperson's own records. Treat them as the only source of truth. Never invent a name, number, promise or date that is not there.
- Be brief and concrete. This person is between calls, often on a phone screen. Lead with the answer.
- Refer to leads by name, not by id. Use the person's local time when you mention when something happened or is due.
- When the records do not answer the question, say so plainly and say what you would need.
- Never fabricate a commitment the salesperson did not make.`;

const LOG_TOOL = {
  name: 'log_interaction',
  description:
    'Record what happened with a lead and what should happen next. Call this exactly once with your best reading of the note.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      lead_id: {
        type: 'string',
        description: 'The id of the matching existing lead. Empty string if the note is about someone not in the list.',
      },
      new_lead_name: {
        type: 'string',
        description: 'Person\'s name when this is someone new. Empty string otherwise.',
      },
      new_lead_company: { type: 'string', description: 'Company for a new lead, else empty string.' },
      new_lead_phone: { type: 'string', description: 'Phone number for a new lead, else empty string.' },
      kind: { type: 'string', enum: ['call', 'text', 'email', 'meeting', 'note'] },
      direction: {
        type: 'string',
        enum: ['out', 'in'],
        description: '"out" if the salesperson reached out, "in" if the lead came to them.',
      },
      outcome: {
        type: 'string',
        enum: ['talked', 'no_answer', 'voicemail', 'callback', 'meeting_booked', 'not_interested', 'closed_won', 'wrong_number', 'other'],
      },
      summary: {
        type: 'string',
        description: 'One clear sentence the salesperson will read months from now. No filler.',
      },
      status: {
        type: 'string',
        enum: ['new', 'contacted', 'nurture', 'hot', 'negotiating', 'won', 'lost', 'unchanged'],
        description: 'Where the lead now sits. Use "unchanged" if the note gives no reason to move them.',
      },
      next_action: {
        type: 'string',
        description: 'Short imperative for the next step, e.g. "Call back about pricing". Empty string if none.',
      },
      next_action_at: {
        type: 'string',
        description: 'When the next step is due, as ISO 8601 with a UTC offset, e.g. 2026-03-14T09:00:00-05:00. Empty string if the note schedules nothing.',
      },
      value: {
        type: 'integer',
        description: 'Deal size in whole currency units if the note states one, otherwise 0.',
      },
      confidence: {
        type: 'number',
        description: 'Between 0 and 1: how sure you are this maps to the right lead.',
      },
    },
    required: [
      'lead_id', 'new_lead_name', 'new_lead_company', 'new_lead_phone', 'kind',
      'direction', 'outcome', 'summary', 'status', 'next_action',
      'next_action_at', 'value', 'confidence',
    ],
    additionalProperties: false,
  },
};

export function createAi({ apiKey, model = 'claude-opus-5' }) {
  const enabled = Boolean(apiKey);
  const client = enabled ? new Anthropic({ apiKey, maxRetries: 2, timeout: 120000 }) : null;
  // Some accounts and proxies do not accept the server-side fallback beta. The
  // first rejection turns it off for the life of the process instead of
  // failing every request after it.
  let fallbacksSupported = true;

  function baseParams(extra) {
    return { model, ...extra };
  }

  async function send(params, { stream = false } = {}) {
    if (!client) throw new AiError('No Anthropic API key is configured.', 503);

    const attempt = async (useFallbacks) => {
      const withFallbacks = useFallbacks
        ? { betas: [FALLBACK_BETA], fallbacks: 'default' }
        : null;
      const surface = withFallbacks ? client.beta.messages : client.messages;
      const body = withFallbacks ? { ...params, ...withFallbacks } : params;
      return stream ? surface.stream(body) : surface.create(body);
    };

    try {
      return await attempt(fallbacksSupported);
    } catch (err) {
      const status = err?.status;
      const text = String(err?.message || '');
      if (fallbacksSupported && (status === 400 || status === 404) && /fallback|beta/i.test(text)) {
        fallbacksSupported = false;
        return attempt(false);
      }
      throw translate(err);
    }
  }

  function translate(err) {
    const status = err?.status;
    if (status === 401) return new AiError('The Anthropic API key was rejected. Check it in Settings.', 401);
    if (status === 429) return new AiError('Hit the API rate limit. Try again in a moment.', 429);
    if (status === 529 || status === 503) return new AiError('Claude is busy right now. Try again shortly.', 503);
    if (err?.name === 'APIConnectionError' || err?.code === 'ENOTFOUND') {
      return new AiError('Could not reach the Anthropic API. Check the connection.', 503);
    }
    if (err instanceof AiError) return err;
    return new AiError(err?.message || 'The AI request failed.', 502);
  }

  function textOf(message) {
    if (message?.stop_reason === 'refusal') {
      throw new AiError('Claude declined to answer that one. Try rephrasing.', 422);
    }
    return (message?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  return {
    enabled,
    model,

    /**
     * Reads a free-text note and returns the fields to save. Falls back to the
     * offline parser whenever the API is unavailable, so logging never breaks.
     */
    async parseLogEntry({ text, leads = [], now = Date.now(), timezone = 'UTC' }) {
      const offline = parseCallLog(text, { now, timezone, leads });
      if (!enabled) return offline;

      try {
        const message = await send(baseParams({
          max_tokens: 2000,
          output_config: { effort: 'low' },
          system: [
            { type: 'text', text: ASSISTANT_ROLE, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'Task: turn one short note about a lead into structured fields. Always call the log_interaction tool.' },
          ],
          tools: [LOG_TOOL],
          tool_choice: { type: 'tool', name: LOG_TOOL.name },
          messages: [{
            role: 'user',
            content: [
              `Right now it is ${new Date(now).toISOString()} (${timezone}, local time ${formatLocal(now, timezone)}).`,
              '',
              'Existing leads:',
              leadIndex(leads),
              '',
              'Note from the salesperson:',
              String(text),
            ].join('\n'),
          }],
        }));

        if (message.stop_reason === 'refusal') return offline;
        const call = (message.content || []).find(
          (block) => block.type === 'tool_use' && block.name === LOG_TOOL.name,
        );
        if (!call) return offline;

        const input = typeof call.input === 'string' ? JSON.parse(call.input) : call.input;
        return shapeParsed(input, { offline, leads, now });
      } catch {
        return { ...offline, degraded: true };
      }
    },

    /** The morning read: who to call, in order, and why. */
    async dailyBrief({ ranked = [], now = Date.now(), timezone = 'UTC', name = '' }) {
      const top = ranked.slice(0, 12);
      if (!top.length) {
        return 'Nothing is due right now. Add a lead or schedule a follow-up and this fills up.';
      }
      const message = await send(baseParams({
        max_tokens: 1500,
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: ASSISTANT_ROLE, cache_control: { type: 'ephemeral' } },
          {
            type: 'text',
            text: `Task: write today's call plan. Open with one sentence on the shape of the day. Then list the calls in the order given, one line each: the name, then why they matter today, then the single thing to say or ask. No headings, no preamble, no sign-off. Under 200 words.`,
          },
        ],
        messages: [{
          role: 'user',
          content: [
            `Salesperson: ${name || 'the user'}. Local time: ${formatLocal(now, timezone)} (${timezone}).`,
            '',
            'Today\'s ranked call list:',
            ...top.map((entry, i) => `${i + 1}. ${describeEntry(entry, timezone, now)}`),
          ].join('\n'),
        }],
      }));
      return textOf(message);
    },

    /** One suggestion for what to do next with a single lead. */
    async suggestNextStep({ lead, interactions = [], now = Date.now(), timezone = 'UTC' }) {
      const message = await send(baseParams({
        max_tokens: 700,
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: ASSISTANT_ROLE, cache_control: { type: 'ephemeral' } },
          {
            type: 'text',
            text: 'Task: recommend the single next move with this lead. Two sentences at most: what to do, and the line to open with. No preamble.',
          },
        ],
        messages: [{
          role: 'user',
          content: [
            `Local time: ${formatLocal(now, timezone)} (${timezone}).`,
            '',
            leadDossier(lead, interactions, timezone, now),
          ].join('\n'),
        }],
      }));
      return textOf(message);
    },

    /**
     * Answers a question about the book of business, streaming the reply so it
     * appears as it is written.
     */
    async answerQuestion({ question, book, history = [], now = Date.now(), timezone = 'UTC', onDelta }) {
      const messages = [];
      for (const turn of history.slice(-8)) {
        if (turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content) {
          messages.push({ role: turn.role, content: String(turn.content).slice(0, 4000) });
        }
      }
      messages.push({
        role: 'user',
        content: [
          `Local time: ${formatLocal(now, timezone)} (${timezone}).`,
          '',
          'My records:',
          book,
          '',
          'My question:',
          String(question),
        ].join('\n'),
      });

      const stream = await send(baseParams({
        max_tokens: 4000,
        output_config: { effort: 'high' },
        system: [
          { type: 'text', text: ASSISTANT_ROLE, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Task: answer the question from the records below. Lead with the answer. Name names. Keep it under 150 words unless a list is genuinely needed.' },
        ],
        messages,
      }), { stream: true });

      let answer = '';
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            answer += event.delta.text;
            if (onDelta) onDelta(event.delta.text);
          }
        }
        const final = await stream.finalMessage();
        if (final?.stop_reason === 'refusal') {
          throw new AiError('Claude declined to answer that one. Try rephrasing.', 422);
        }
      } catch (err) {
        if (err instanceof AiError) throw err;
        throw translate(err);
      }
      return answer.trim();
    },
  };
}

// --- context formatting -----------------------------------------------------

function formatLocal(ms, timezone) {
  const p = zonedParts(ms, timezone);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return `${p.weekday} ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${hour12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
}

function leadIndex(leads) {
  const rows = leads.filter((l) => !l.deleted).slice(0, 300);
  if (!rows.length) return '(no leads yet)';
  return rows
    .map((l) => `- ${l.id} | ${l.name || '(no name)'} | ${l.company || '-'} | ${l.phone || '-'} | ${l.status}`)
    .join('\n');
}

function describeEntry(entry, timezone, now) {
  const l = entry.lead;
  const bits = [
    `${l.name || '(unnamed)'}${l.company ? ` at ${l.company}` : ''}`,
    `stage ${STATUS_LABELS[l.status] || l.status}`,
    entry.reason,
  ];
  if (l.value) bits.push(`worth ${l.value}`);
  if (entry.lastContactAt) bits.push(`last spoke ${describeTime(entry.lastContactAt, timezone, now)}`);
  if (l.notes) bits.push(`notes: ${String(l.notes).slice(0, 200)}`);
  return bits.join(' -- ');
}

export function leadDossier(lead, interactions, timezone, now) {
  const lines = [
    `Lead: ${lead.name || '(unnamed)'}`,
    lead.company ? `Company: ${lead.company}` : null,
    `Stage: ${STATUS_LABELS[lead.status] || lead.status}`,
    lead.value ? `Deal size: ${lead.value}` : null,
    lead.source ? `Source: ${lead.source}` : null,
    lead.next_action ? `Planned next step: ${lead.next_action}${lead.next_action_at ? ` (${describeTime(lead.next_action_at, timezone, now)})` : ''}` : null,
    lead.notes ? `Notes: ${lead.notes}` : null,
    '',
    'History, newest first:',
  ].filter(Boolean);

  const history = [...interactions]
    .filter((i) => !i.deleted)
    .sort((a, b) => (b.occurred_at || 0) - (a.occurred_at || 0))
    .slice(0, 25);

  if (!history.length) lines.push('(never contacted)');
  for (const item of history) {
    lines.push(
      `- ${describeTime(item.occurred_at, timezone, now)} | ${item.kind}${item.outcome ? `/${item.outcome}` : ''} | ${item.summary || item.body || ''}`.slice(0, 400),
    );
  }
  return lines.join('\n');
}

/**
 * Compact view of the whole book, used as context for free-form questions.
 * Trimmed so a large pipeline still fits comfortably in one request.
 */
export function buildBook({ leads = [], interactions = [], tasks = [], timezone = 'UTC', now = Date.now() }) {
  const byLead = new Map();
  for (const item of interactions) {
    if (item.deleted) continue;
    if (!byLead.has(item.lead_id)) byLead.set(item.lead_id, []);
    byLead.get(item.lead_id).push(item);
  }

  const openTasks = tasks.filter((t) => !t.deleted && !t.done_at);
  const lines = [];

  for (const lead of leads.filter((l) => !l.deleted).slice(0, 250)) {
    const history = (byLead.get(lead.id) || [])
      .sort((a, b) => (b.occurred_at || 0) - (a.occurred_at || 0))
      .slice(0, 6);
    lines.push(
      [
        `## ${lead.name || '(unnamed)'}${lead.company ? ` -- ${lead.company}` : ''}`,
        `stage: ${STATUS_LABELS[lead.status] || lead.status}` +
          (lead.phone ? ` | phone: ${lead.phone}` : '') +
          (lead.email ? ` | email: ${lead.email}` : '') +
          (lead.value ? ` | value: ${lead.value}` : '') +
          (lead.tags ? ` | tags: ${lead.tags}` : ''),
        lead.next_action_at
          ? `next: ${lead.next_action || 'follow up'} on ${describeTime(lead.next_action_at, timezone, now)}`
          : (lead.next_action ? `next: ${lead.next_action}` : null),
        lead.notes ? `notes: ${String(lead.notes).slice(0, 400)}` : null,
        ...history.map(
          (h) => `  - ${describeTime(h.occurred_at, timezone, now)} ${h.kind}${h.outcome ? `/${h.outcome}` : ''}: ${String(h.summary || h.body || '').slice(0, 300)}`,
        ),
      ].filter(Boolean).join('\n'),
    );
  }

  if (openTasks.length) {
    lines.push('## Open reminders');
    for (const task of openTasks.slice(0, 50)) {
      lines.push(`- ${task.title}${task.due_at ? ` (due ${describeTime(task.due_at, timezone, now)})` : ''}`);
    }
  }

  return lines.join('\n\n') || '(no leads recorded yet)';
}

function shapeParsed(input, { offline, leads, now }) {
  const known = new Set(leads.map((l) => l.id));
  const leadId = typeof input.lead_id === 'string' && known.has(input.lead_id) ? input.lead_id : null;

  let nextActionAt = null;
  if (typeof input.next_action_at === 'string' && input.next_action_at.trim()) {
    const parsed = Date.parse(input.next_action_at);
    if (Number.isFinite(parsed)) nextActionAt = parsed;
  }

  const status = input.status && input.status !== 'unchanged' ? input.status : null;

  return {
    leadId,
    leadName: leadId
      ? (leads.find((l) => l.id === leadId)?.name ?? null)
      : (input.new_lead_name || null),
    newLead: leadId ? null : {
      name: input.new_lead_name || '',
      company: input.new_lead_company || '',
      phone: input.new_lead_phone || '',
    },
    confidence: typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.5,
    kind: input.kind || offline.kind,
    direction: input.direction || offline.direction,
    outcome: input.outcome === 'other' ? '' : (input.outcome || offline.outcome),
    status,
    summary: input.summary || offline.summary,
    body: offline.body,
    occurredAt: now,
    nextActionAt,
    nextAction: input.next_action || '',
    value: Number.isFinite(input.value) && input.value > 0 ? Math.trunc(input.value) : null,
    source: 'claude',
  };
}
