import { useEffect, useRef, useState } from 'react';
import { Empty, Notice } from '../components/ui.jsx';
import { IconSend, IconSpark } from '../components/icons.jsx';
import { askStream, flushChanges } from '../store.js';

const SUGGESTIONS = [
  'Who have I not called in over a week?',
  'What did I last say to my hottest lead?',
  'Which deals are worth the most right now?',
  'Did I promise anyone anything I have not done?',
];

export function AskView({ state }) {
  const [turns, setTurns] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(text) {
    const value = (text ?? question).trim();
    if (!value || busy) return;

    setQuestion('');
    setError('');
    setBusy(true);

    const history = turns
      .filter((turn) => !turn.failed)
      .map((turn) => ({ role: turn.role, content: turn.content }));

    setTurns((current) => [
      ...current,
      { role: 'user', content: value },
      { role: 'assistant', content: '', streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await flushChanges();
      await askStream({
        question: value,
        history,
        signal: controller.signal,
        onDelta: (delta) => {
          setTurns((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + delta };
            }
            return copy;
          });
        },
      });
      setTurns((current) => {
        const copy = [...current];
        const last = copy[copy.length - 1];
        if (last) copy[copy.length - 1] = { ...last, streaming: false };
        return copy;
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const message = err?.message || 'Could not answer that.';
      setError(message);
      setTurns((current) => {
        const copy = [...current];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          copy[copy.length - 1] = { role: 'assistant', content: message, failed: true };
        }
        return copy;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  if (!state.aiEnabled) {
    return (
      <Empty title="The assistant is switched off">
        No Anthropic API key is set on the server, so there is nobody to ask yet.
        Everything else in the app works without it. Settings explains how to add one.
      </Empty>
    );
  }

  return (
    <>
      {!turns.length ? (
        <div style={{ marginBottom: 18 }}>
          <div className="empty" style={{ paddingBottom: 18 }}>
            <IconSpark style={{ width: 28, height: 28, color: 'var(--brand)', marginBottom: 8 }} />
            <h3>Ask about anyone</h3>
            <p>I have read every note you have written. Ask the way you would ask a person.</p>
          </div>
          <div className="chips" style={{ justifyContent: 'center' }}>
            {SUGGESTIONS.map((item) => (
              <button key={item} className="chip" onClick={() => ask(item)}>{item}</button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="chat">
        {turns.map((turn, index) => (
          <div
            key={index}
            className={`bubble ${turn.role === 'user' ? 'me' : 'them'}${turn.failed ? ' failed' : ''}`}
          >
            {turn.content || (turn.streaming ? 'Thinking...' : '')}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <Notice kind="error">{error}</Notice>

      <form
        className="composer"
        onSubmit={(event) => { event.preventDefault(); ask(); }}
      >
        <input
          className="input"
          placeholder="Ask about your leads"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={busy}
        />
        <button className="btn primary" type="submit" disabled={busy || !question.trim()} aria-label="Send">
          <IconSend />
        </button>
      </form>
    </>
  );
}
