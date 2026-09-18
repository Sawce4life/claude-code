import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet, Field, Notice, toLocalInput, fromLocalInput } from './ui.jsx';
import { IconMic, IconSpark, IconCheck } from './icons.jsx';
import { api } from '../api.js';
import { applyDraft, liveLeads, timezoneOf, getState } from '../store.js';
import { parseCallLog } from '@shared/nlp.js';
import { OUTCOME_LABELS, KIND_LABELS } from '@shared/records.js';
import { describeTime } from '@shared/timezone.js';

const EXAMPLES = [
  'Just got off with Mike at Acme. Interested but wants to run it past his partner. Call back Thursday morning.',
  'No answer on Dana, try again tomorrow at 2.',
  'Sara signed! Send the paperwork Monday.',
];

function useDictation(onText) {
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);

  const supported = typeof window !== 'undefined'
    && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggle = () => {
    if (!supported) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const said = Array.from(event.results).map((r) => r[0].transcript).join(' ');
      onText(said.trim());
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  useEffect(() => () => recognitionRef.current?.abort?.(), []);
  return { supported, listening, toggle };
}

export function QuickLog({ lead = null, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [usedAi, setUsedAi] = useState(false);

  const snapshot = getState();
  const leads = useMemo(() => liveLeads(snapshot), [snapshot.leads]);
  const timezone = timezoneOf(snapshot);
  const placeholder = useMemo(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)], []);

  const dictation = useDictation((said) => {
    setText((current) => (current ? `${current} ${said}` : said));
  });

  async function read() {
    const value = text.trim();
    if (!value) { setError('Type or say what happened first.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await api.parse(value);
      setDraft(normalize(result.draft, lead));
      setUsedAi(result.draft?.source === 'claude');
    } catch {
      // Offline, or the server has no key: read it here instead.
      const offline = parseCallLog(value, { now: Date.now(), timezone, leads });
      setDraft(normalize(offline, lead));
      setUsedAi(false);
    } finally {
      setBusy(false);
    }
  }

  function normalize(incoming, forLead) {
    const chosen = forLead ? forLead.id : incoming.leadId;
    return {
      ...incoming,
      leadId: chosen || null,
      newLead: chosen ? null : (incoming.newLead || { name: incoming.leadName || '', company: '', phone: '' }),
    };
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await applyDraft(draft);
      onSaved?.(result);
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not save that.');
      setBusy(false);
    }
  }

  const matched = draft?.leadId ? leads.find((l) => l.id === draft.leadId) : null;

  return (
    <Sheet
      title={lead ? `Log something for ${lead.name || 'this lead'}` : 'Log a call'}
      hint="Write it the way you would say it. Everything below stays editable."
      onClose={onClose}
    >
      <Notice kind="error">{error}</Notice>

      {!draft ? (
        <>
          <Field label="What happened?">
            <textarea
              className="textarea"
              value={text}
              placeholder={placeholder}
              onChange={(event) => setText(event.target.value)}
              rows={4}
            />
          </Field>

          <div className="btn-row">
            <button className="btn primary" onClick={read} disabled={busy}>
              <IconSpark /> {busy ? 'Reading...' : 'Read it'}
            </button>
            {dictation.supported ? (
              <button
                className="btn"
                onClick={dictation.toggle}
                aria-pressed={dictation.listening}
                style={dictation.listening ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : undefined}
              >
                <IconMic /> {dictation.listening ? 'Listening...' : 'Dictate'}
              </button>
            ) : null}
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div className="notice info" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <IconCheck style={{ width: 17, height: 17, flex: 'none' }} />
            <span>{usedAi ? 'Read by the assistant.' : 'Read on this device.'} Check it and save.</span>
          </div>

          {!lead ? (
            <Field label="Who was this about?">
              <select
                className="input"
                value={draft.leadId || '__new'}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft({
                    ...draft,
                    leadId: value === '__new' ? null : value,
                    newLead: value === '__new'
                      ? (draft.newLead || { name: draft.leadName || '', company: '', phone: '' })
                      : null,
                  });
                }}
              >
                <option value="__new">+ Somebody new</option>
                {leads.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || '(unnamed)'}{item.company ? ` -- ${item.company}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {!draft.leadId ? (
            <div className="grid-2">
              <Field label="Name">
                <input
                  className="input"
                  value={draft.newLead?.name || ''}
                  onChange={(e) => setDraft({ ...draft, newLead: { ...draft.newLead, name: e.target.value } })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="input"
                  inputMode="tel"
                  value={draft.newLead?.phone || ''}
                  onChange={(e) => setDraft({ ...draft, newLead: { ...draft.newLead, phone: e.target.value } })}
                />
              </Field>
            </div>
          ) : null}

          <div className="grid-2">
            <Field label="Type">
              <select
                className="input"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              >
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="How did it go?">
              <select
                className="input"
                value={draft.outcome || ''}
                onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
              >
                <option value="">Not recorded</option>
                {Object.entries(OUTCOME_LABELS)
                  .filter(([value]) => value)
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Summary">
            <textarea
              className="textarea"
              rows={3}
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
          </Field>

          <div className="grid-2">
            <Field label="Next step">
              <input
                className="input"
                placeholder="Call back about pricing"
                value={draft.nextAction || ''}
                onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })}
              />
            </Field>
            <Field
              label="When"
              hint={draft.nextActionAt ? describeTime(draft.nextActionAt, timezone, Date.now()) : 'Leave empty for none'}
            >
              <input
                className="input"
                type="datetime-local"
                value={toLocalInput(draft.nextActionAt)}
                onChange={(e) => setDraft({ ...draft, nextActionAt: fromLocalInput(e.target.value) })}
              />
            </Field>
          </div>

          {matched ? (
            <p className="tiny" style={{ marginTop: -4, marginBottom: 12 }}>
              Saving to {matched.name}{matched.company ? ` at ${matched.company}` : ''}.
            </p>
          ) : null}

          <div className="btn-row">
            <button className="btn primary" onClick={save} disabled={busy}>
              <IconCheck /> Save it
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>Back</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
