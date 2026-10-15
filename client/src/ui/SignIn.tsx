/**
 * Hosted mode only: sign in with CHT credentials, the way cht-user-management
 * does. The server checks them against the chosen CHT instance (one of its
 * CHT_INSTANCES) and lets the person in if their CHT roles hold the required
 * permissions. There is no sign-up: a CHT user is the account. The token comes
 * back from the server and is kept in localStorage by the api layer; desktop
 * mode never renders this (there is one implicit local user).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, session } from '../api.js';
import { useApp } from '../state/store.js';

export function SignIn() {
  const setSession = useApp((s) => s.setSession);
  const [instances, setInstances] = useState<{ url: string; label: string }[] | null>(null);
  const [instance, setInstance] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .signInInstances()
      .then((r) => {
        setInstances(r.instances);
        if (r.instances.length) setInstance(r.instances[0]!.url);
      })
      .catch((e: Error) => {
        setInstances([]);
        setError(e.message);
      });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(instance, username, password);
      session.setToken(r.token);
      setSession({
        mode: 'hosted',
        user: { id: r.user.id, name: r.user.name, instance: r.user.instance },
      });
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
        <p className="subtitle">
          Build a Community Health Toolkit app in your browser. Nothing to install.
        </p>
        <h2 className="signin-title">Sign in</h2>
        <p className="muted small">Use your username and password for the CHT instance below.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="form-row">
          <label htmlFor="signin-instance">CHT instance</label>
          {instances && instances.length > 1 ? (
            <select
              id="signin-instance"
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
            >
              {instances.map((i) => (
                <option key={i.url} value={i.url}>
                  {i.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="signin-instance"
              readOnly
              value={instances?.[0]?.label ?? (instances ? 'None configured' : '…')}
            />
          )}
        </div>
        <div className="form-row">
          <label htmlFor="signin-username">Username</label>
          <input
            id="signin-username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy || !instance} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : 'Sign in'}
        </button>
        <hr className="divider" />
        <p className="hint">
          This is a test platform for trying CHT. Projects you build are yours — download them any
          time and deploy to your own CHT instance. Do not enter real patient data here.
        </p>
      </form>
    </div>
  );
}
