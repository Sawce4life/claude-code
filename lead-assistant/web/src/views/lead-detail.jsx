import { useMemo, useState } from 'react';
import { Field, Notice, Sheet, StatusSelect, toLocalInput, fromLocalInput } from '../components/ui.jsx';
import {
  IconPhone, IconMail, IconSpark, IconPencil, IconTrash, IconClock, IconCheck,
} from '../components/icons.jsx';
import { api } from '../api.js';
import {
  interactionsFor, saveLead, removeRow, logQuickOutcome, snooze, timezoneOf,
} from '../store.js';
import { STATUS_LABELS } from '@shared/priority.js';
import { OUTCOME_LABELS, KIND_LABELS } from '@shared/records.js';
import { describeTime, addDays, startOfDay, nextWeekday } from '@shared/timezone.js';

const QUICK = [
  { outcome: 'talked', label: 'Talked' },
  { outcome: 'no_answer', label: 'No answer' },
  { outcome: 'voicemail', label: 'Left VM' },
  { outcome: 'meeting_booked', label: 'Booked' },
  { outcome: 'closed_won', label: 'Won' },
  { outcome: 'not_interested', label: 'Not interested' },
];

const REACHED = new Set(['talked', 'meeting_booked', 'closed_won', 'not_interested', 'callback']);

export function LeadDetailView({ state, leadId, onOpenLead, onLog, onBack }) {
  const [editing, setEditing] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickingTime, setPickingTime] = useState(false);

  const now = Date.now();
  const timezone = timezoneOf(state);
  const lead = state.leads.find((item) => item.id === leadId && !item.deleted);
  const history = useMemo(
    () => interactionsFor(leadId, state),
    [state.interactions, leadId],
  );

  if (!lead) {
    return (
      <div className="empty">
        <h3>That lead is gone</h3>
        <p>It may have been deleted on another device.</p>
        <button className="btn" style={{ marginTop: 14 }} onClick={onBack}>Back to the list</button>
      </div>
    );
  }

  const telHref = lead.phone ? `tel:${String(lead.phone).replace(/[^\d+]/g, '')}` : null;

  async function askForSuggestion() {
    setSuggestBusy(true);
    setError('');
    try {
      const result = await api.suggest(lead.id);
      setSuggestion(result.suggestion);
    } catch (err) {
      setError(err?.message || 'Could not come up with anything.');
    } finally {
      setSuggestBusy(false);
    }
  }

  const laterChoices = [
    { label: 'Tomorrow 9am', at: startOfDay(addDays(now, 1, timezone), timezone) + 9 * 3600000 },
    { label: 'In 3 days', at: startOfDay(addDays(now, 3, timezone), timezone) + 9 * 3600000 },
    { label: 'Monday 9am', at: nextWeekday(now, 1, 9, 0, timezone) },
    { label: 'In 2 weeks', at: startOfDay(addDays(now, 14, timezone), timezone) + 9 * 3600000 },
  ];

  return (
    <>
      <Notice kind="error">{error}</Notice>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 21, letterSpacing: '-.015em' }}>
              {lead.name || '(no name yet)'}
            </h2>
            {lead.company ? <div className="muted" style={{ marginTop: 2 }}>{lead.company}</div> : null}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
              <span className="pill brand">{STATUS_LABELS[lead.status] || lead.status}</span>
              {lead.value ? <span className="pill due">{Number(lead.value).toLocaleString()}</span> : null}
              {lead.source ? <span className="pill due">{lead.source}</span> : null}
              {lead.do_not_call ? <span className="pill overdue">Do not call</span> : null}
            </div>
          </div>
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit this lead">
            <IconPencil />
          </button>
        </div>

        <div className="btn-row" style={{ marginTop: 14 }}>
          {telHref ? (
            <a className="btn primary" href={telHref}><IconPhone /> Call</a>
          ) : null}
          {lead.email ? (
            <a className="btn" href={`mailto:${lead.email}`}><IconMail /> Email</a>
          ) : null}
          <button className="btn" onClick={() => onLog(lead)}><IconPencil /> Log</button>
        </div>
      </div>

      <section className="section">
        <div className="section-head"><h2>Next step</h2></div>
        <div className="card" style={{ padding: 14 }}>
          {lead.next_action_at || lead.next_action ? (
            <>
              <div style={{ fontWeight: 600 }}>{lead.next_action || 'Follow up'}</div>
              {lead.next_action_at ? (
                <div
                  className="muted"
                  style={{ marginTop: 2, color: lead.next_action_at < now ? 'var(--danger)' : undefined }}
                >
                  {lead.next_action_at < now ? 'Was due ' : 'Due '}
                  {describeTime(lead.next_action_at, timezone, now)}
                </div>
              ) : <div className="muted" style={{ marginTop: 2 }}>No date set</div>}
            </>
          ) : (
            <div className="muted">Nothing scheduled.</div>
          )}

          {pickingTime ? (
            <div className="chips" style={{ marginTop: 12 }}>
              {laterChoices.map((choice) => (
                <button
                  key={choice.label}
                  className="chip"
                  onClick={async () => { await snooze(lead.id, choice.at); setPickingTime(false); }}
                >
                  {choice.label}
                </button>
              ))}
              <button className="chip" onClick={() => setPickingTime(false)}>Cancel</button>
            </div>
          ) : (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => setPickingTime(true)}>
                <IconClock /> {lead.next_action_at ? 'Move it' : 'Schedule'}
              </button>
              {lead.next_action_at ? (
                <button
                  className="btn small ghost"
                  onClick={() => saveLead({ id: lead.id, next_action_at: null, next_action: '' })}
                >
                  Clear
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Log this call in one tap</h2></div>
        <div className="chips">
          {QUICK.map((item) => (
            <button
              key={item.outcome}
              className="chip"
              onClick={() => logQuickOutcome(lead.id, item.outcome)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {state.aiEnabled ? (
        <section className="section">
          {suggestion ? (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <IconSpark style={{ width: 16, height: 16, color: 'var(--brand)' }} />
                <strong style={{ fontSize: 14 }}>What I would do</strong>
              </div>
              <div style={{ fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{suggestion}</div>
            </div>
          ) : (
            <button className="btn wide" onClick={askForSuggestion} disabled={suggestBusy}>
              <IconSpark /> {suggestBusy ? 'Thinking...' : 'What should I do next?'}
            </button>
          )}
        </section>
      ) : null}

      {lead.notes ? (
        <section className="section">
          <div className="section-head"><h2>Notes</h2></div>
          <div className="card" style={{ padding: 14, whiteSpace: 'pre-wrap', fontSize: 14.5 }}>
            {lead.notes}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>History</h2>
          <span className="tiny">{history.length}</span>
        </div>
        {history.length ? (
          <ul className="timeline">
            {history.map((item) => {
              const { headline, detail } = readEntry(item);
              return (
                <li key={item.id} className={REACHED.has(item.outcome) ? 'reached' : undefined}>
                  <div className="when">
                    {describeTime(item.occurred_at, timezone, now)}
                    {' · '}
                    {KIND_LABELS[item.kind] || item.kind}
                    {item.outcome ? ` · ${OUTCOME_LABELS[item.outcome] || item.outcome}` : ''}
                  </div>
                  <div className="what">{headline}</div>
                  {detail ? (
                    <div className="muted" style={{ marginTop: 3, whiteSpace: 'pre-wrap' }}>{detail}</div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="card" style={{ padding: 16 }} >
            <div className="muted">Nothing logged yet. Tap Log after your first call.</div>
          </div>
        )}
      </section>

      <div className="btn-row" style={{ marginTop: 8 }}>
        {confirmDelete ? (
          <>
            <button
              className="btn danger"
              onClick={async () => { await removeRow('leads', lead.id); onBack(); }}
            >
              <IconTrash /> Yes, delete
            </button>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmDelete(true)}>
            <IconTrash /> Delete this lead
          </button>
        )}
      </div>

      {editing ? (
        <EditLead lead={lead} timezone={timezone} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

function EditLead({ lead, onClose }) {
  const [form, setForm] = useState({
    name: lead.name, company: lead.company, phone: lead.phone, email: lead.email,
    source: lead.source, status: lead.status, value: String(lead.value || ''),
    tags: lead.tags, notes: lead.notes, next_action: lead.next_action,
    next_action_at: lead.next_action_at, do_not_call: Boolean(lead.do_not_call),
  });
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    await saveLead({
      id: lead.id,
      ...form,
      value: Number(form.value) || 0,
      do_not_call: form.do_not_call ? 1 : 0,
    });
    onClose();
  }

  return (
    <Sheet title="Edit lead" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} /></Field>
        <div className="grid-2">
          <Field label="Phone"><input className="input" inputMode="tel" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Company"><input className="input" value={form.company} onChange={set('company')} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Where from?"><input className="input" value={form.source} onChange={set('source')} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Stage"><StatusSelect value={form.status} onChange={(status) => setForm({ ...form, status })} /></Field>
          <Field label="Deal size"><input className="input" inputMode="numeric" value={form.value} onChange={set('value')} /></Field>
        </div>
        <Field label="Tags" hint="Separate with commas">
          <input className="input" value={form.tags} onChange={set('tags')} />
        </Field>
        <div className="grid-2">
          <Field label="Next step"><input className="input" value={form.next_action} onChange={set('next_action')} /></Field>
          <Field label="When">
            <input
              className="input"
              type="datetime-local"
              value={toLocalInput(form.next_action_at)}
              onChange={(event) => setForm({ ...form, next_action_at: fromLocalInput(event.target.value) })}
            />
          </Field>
        </div>
        <Field label="Notes"><textarea className="textarea" rows={4} value={form.notes} onChange={set('notes')} /></Field>
        <label className="field" style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={form.do_not_call}
            onChange={(event) => setForm({ ...form, do_not_call: event.target.checked })}
            style={{ width: 20, height: 20 }}
          />
          <span style={{ margin: 0 }}>Do not call -- keep them off the list</span>
        </label>
        <div className="btn-row">
          <button className="btn primary" type="submit" disabled={busy}><IconCheck /> Save</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * A summary that is only a shortened copy of the note adds nothing, so the
 * full note is shown on its own instead of printing both.
 */
function readEntry(item) {
  const summary = String(item.summary || '').trim();
  const body = String(item.body || '').trim();
  if (!body || body === summary) return { headline: summary || '(no note)', detail: null };
  const stem = summary.replace(/\.{3}$/, '');
  if (!summary || (stem && body.startsWith(stem))) return { headline: body, detail: null };
  return { headline: summary, detail: body };
}
