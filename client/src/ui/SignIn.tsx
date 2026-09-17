/**
 * Hosted mode only: create an account or sign in. The token comes back from
 * the server and is kept in localStorage by the api layer; desktop mode never
 * renders this (there is one implicit local user).
 */
import { useState, type FormEvent } from 'react';
import { api, session } from '../api.js';
import { useApp } from '../state/store.js';

export function SignIn() {
  const setSession = useApp((s) => s.setSession);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.signup(email, password);
      session.setToken(r.token);
      setSession({ mode: 'hosted', user: { id: r.user.id, email: r.user.email } });
    } catch (err) {
      setError((err as Error).message.replace(/^\d{3} [^—]*— /, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-picker">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1>CHT UI Builder</h1>
        <p className="subtitle">Build a Community Health Toolkit app in your browser. Nothing to install.</p>
        <h2 className="signin-title">{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="form-row">
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'signup' && <p className="muted small">At least 8 characters.</p>}
        </div>
        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <p className="muted small signin-switch">
          {mode === 'login' ? (
            <>
              New here?{' '}
              <button type="button" className="link" onClick={() => setMode('signup')}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" className="link" onClick={() => setMode('login')}>
                Sign in
              </button>
            </>
          )}
        </p>
        <hr className="divider" />
        <p className="hint">
          This is a test platform for trying CHT. Projects you build are yours — download them any
          time and deploy to your own CHT instance. Do not enter real patient data here.
        </p>
      </form>
    </div>
  );
}
