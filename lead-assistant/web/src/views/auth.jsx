import { useState } from 'react';
import { Field, Notice } from '../components/ui.jsx';
import { signIn, signUp } from '../store.js';

export function AuthView({ signupsOpen }) {
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const registering = mode === 'signup';

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (registering) await signUp(form);
      else await signIn(form.email, form.password);
    } catch (err) {
      setError(err?.message || 'That did not work.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brandmark">
          <img src="/icon.svg" alt="" width="42" height="42" />
          <div>
            <strong>Lead Assistant</strong>
            <div className="tiny">Who to call, and what you said last time.</div>
          </div>
        </div>

        <form onSubmit={submit}>
          <Notice kind="error">{error}</Notice>

          {registering ? (
            <Field label="Your name">
              <input className="input" value={form.name} onChange={set('name')} autoComplete="name" />
            </Field>
          ) : null}

          <Field label="Email">
            <input
              className="input"
              type="email"
              required
              value={form.email}
              onChange={set('email')}
              autoComplete="email"
              autoCapitalize="none"
            />
          </Field>

          <Field label="Password" hint={registering ? 'At least 8 characters.' : undefined}>
            <input
              className="input"
              type="password"
              required
              value={form.password}
              onChange={set('password')}
              autoComplete={registering ? 'new-password' : 'current-password'}
            />
          </Field>

          <button className="btn primary wide" type="submit" disabled={busy} style={{ marginTop: 6 }}>
            {busy ? 'One moment...' : registering ? 'Create my account' : 'Sign in'}
          </button>
        </form>

        {signupsOpen ? (
          <p className="center muted" style={{ marginBottom: 0, marginTop: 16 }}>
            {registering ? 'Already set up?' : 'First time here?'}{' '}
            <button
              className="btn ghost small"
              onClick={() => { setMode(registering ? 'signin' : 'signup'); setError(''); }}
            >
              {registering ? 'Sign in instead' : 'Create an account'}
            </button>
          </p>
        ) : (
          <p className="tiny center" style={{ marginTop: 16, marginBottom: 0 }}>
            Sign-ups are closed on this server.
          </p>
        )}
      </div>
    </div>
  );
}
