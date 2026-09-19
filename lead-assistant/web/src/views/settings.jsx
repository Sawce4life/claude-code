import { useMemo, useState } from 'react';
import { Field, Notice, Sheet } from '../components/ui.jsx';
import { IconRefresh, IconCheck } from '../components/icons.jsx';
import { api } from '../api.js';
import { updateProfile, signOut, forceSync, liveLeads, interactionsFor } from '../store.js';
import { describeTime } from '@shared/timezone.js';

const ZONES = (() => {
  try {
    const all = Intl.supportedValuesOf?.('timeZone');
    if (all?.length) return all;
  } catch { /* fall through */ }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
    'Australia/Sydney'];
})();

export function SettingsView({ state }) {
  const [name, setName] = useState(state.user?.name || '');
  const [timezone, setTimezone] = useState(state.user?.timezone || 'UTC');
  // The saved zone must always be one of the options, or the select would show
  // somebody else's zone and quietly save it on the next tap.
  const zones = useMemo(() => {
    const set = new Set(['UTC', ...ZONES]);
    if (timezone) set.add(timezone);
    return [...set].sort();
  }, [timezone]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  async function saveProfile(event) {
    event.preventDefault();
    setError('');
    try {
      await updateProfile({ name, timezone });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err?.message || 'Could not save that.');
    }
  }

  function exportJson() {
    download(
      `lead-assistant-${new Date().toISOString().slice(0, 10)}.json`,
      'application/json',
      JSON.stringify({
        exportedAt: new Date().toISOString(),
        leads: state.leads.filter((l) => !l.deleted),
        interactions: state.interactions.filter((i) => !i.deleted),
        tasks: state.tasks.filter((t) => !t.deleted),
      }, null, 2),
    );
  }

  function exportCsv() {
    const columns = ['name', 'company', 'phone', 'email', 'status', 'value', 'source',
      'next_action', 'next_action_at', 'last_contact_at', 'tags', 'notes'];
    const escape = (value) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [columns.join(',')];
    for (const lead of liveLeads(state)) {
      rows.push(columns.map((column) => {
        if (column === 'next_action_at' || column === 'last_contact_at') {
          return lead[column] ? new Date(lead[column]).toISOString() : '';
        }
        return escape(lead[column]);
      }).join(','));
    }
    download(`leads-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', rows.join('\n'));
  }

  const totals = {
    leads: liveLeads(state).length,
    logged: state.interactions.filter((i) => !i.deleted).length,
  };

  return (
    <>
      <section className="section">
        <div className="section-head"><h2>Your account</h2></div>
        <form className="card" style={{ padding: 16 }} onSubmit={saveProfile}>
          <Notice kind="error">{error}</Notice>
          <Field label="Signed in as">
            <input className="input" value={state.user?.email || ''} disabled />
          </Field>
          <Field label="Your name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Time zone" hint="Everything the assistant says about time uses this.">
            <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </Field>
          <div className="btn-row">
            <button className="btn primary" type="submit">
              {saved ? <><IconCheck /> Saved</> : 'Save'}
            </button>
            <button className="btn" type="button" onClick={() => setChangingPassword(true)}>
              Change password
            </button>
          </div>
        </form>
      </section>

      <section className="section">
        <div className="section-head"><h2>Sync</h2></div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
            <span className={`sync-dot ${state.sync.status}`} />
            <strong style={{ fontSize: 14.5 }}>{syncLabel(state)}</strong>
          </div>
          <div className="muted">
            {state.sync.pending
              ? `${state.sync.pending} change${state.sync.pending === 1 ? '' : 's'} waiting to upload.`
              : 'Everything on this device is on the server.'}
          </div>
          {state.sync.lastSyncAt ? (
            <div className="tiny" style={{ marginTop: 4 }}>
              Last synced {describeTime(state.sync.lastSyncAt, timezone, Date.now())}
            </div>
          ) : null}
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn small" onClick={() => forceSync()}>
              <IconRefresh /> Sync now
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Put it on this device</h2></div>
        <div className="card" style={{ padding: 16, fontSize: 14.5, lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}>
            This app installs straight from the browser. It then opens like any other app, with
            its own icon, and keeps working when you have no signal.
          </p>
          <p style={{ margin: '10px 0 4px' }}><strong>iPhone or iPad</strong></p>
          <p className="muted" style={{ margin: 0 }}>
            Open this page in Safari, tap Share, then Add to Home Screen.
          </p>
          <p style={{ margin: '10px 0 4px' }}><strong>Android</strong></p>
          <p className="muted" style={{ margin: 0 }}>
            Open in Chrome, tap the three dots, then Install app.
          </p>
          <p style={{ margin: '10px 0 4px' }}><strong>Mac or Windows</strong></p>
          <p className="muted" style={{ margin: 0 }}>
            In Chrome or Edge, click the install icon in the address bar, or use the menu and
            choose Install. On a Mac in Safari, use File, then Add to Dock.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Your data</h2></div>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ marginBottom: 12 }}>
            {totals.leads} lead{totals.leads === 1 ? '' : 's'} and {totals.logged} logged
            interaction{totals.logged === 1 ? '' : 's'}. It is yours -- take a copy any time.
          </div>
          <div className="btn-row">
            <button className="btn small" onClick={exportCsv}>Export leads (CSV)</button>
            <button className="btn small" onClick={exportJson}>Export everything (JSON)</button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>The assistant</h2></div>
        <div className="card" style={{ padding: 16 }}>
          {state.aiEnabled ? (
            <div className="muted">
              Switched on. The daily plan, note reading, and questions all run through Claude.
            </div>
          ) : (
            <div className="muted">
              Switched off. Add an Anthropic API key to the server as ANTHROPIC_API_KEY and
              restart it. Everything else works without it, including reading your notes -- that
              just falls back to the simpler reader on your device.
            </div>
          )}
        </div>
      </section>

      <button className="btn danger wide" onClick={() => signOut()} style={{ marginBottom: 8 }}>
        Sign out on this device
      </button>
      <p className="tiny center">
        Signing out clears the copy stored on this device. Your data stays on the server.
      </p>

      {changingPassword ? <ChangePassword onClose={() => setChangingPassword(false)} /> : null}
    </>
  );
}

function syncLabel(state) {
  if (!state.online || state.sync.status === 'offline') return 'Offline';
  if (state.sync.status === 'syncing') return 'Syncing...';
  if (state.sync.status === 'error') return state.sync.message || 'Sync problem';
  return 'Up to date';
}

function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not change it.');
      setBusy(false);
    }
  }

  return (
    <Sheet title="Change password" onClose={onClose}>
      <form onSubmit={submit}>
        <Notice kind="error">{error}</Notice>
        <Field label="Current password">
          <input className="input" type="password" value={current} autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <input className="input" type="password" value={next} autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div className="btn-row">
          <button className="btn primary" type="submit" disabled={busy}>Change it</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}

function download(filename, type, contents) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
