import { useState, type FormEvent } from 'react';
import { setToken, verifyToken } from '../api/client';

/** The operator enters their token; it lives only in this tab's session storage. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await verifyToken(value.trim())) {
        setToken(value.trim());
        onLogin();
      } else {
        setError('Token rejected by the ASTRA API.');
      }
    } catch {
      setError('Cannot reach the ASTRA API.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="brand">
          <span className="brand-mark">▲</span>
          <div>
            <div className="brand-name">ASTRA</div>
            <div className="brand-sub">Command Center</div>
          </div>
        </div>
        <label htmlFor="token">Access token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="operator or viewer token"
          required
        />
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary" disabled={busy || value.trim().length === 0}>
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
        <p className="muted small">
          The token is kept only for this browser tab and is never stored in the application bundle.
        </p>
      </form>
    </div>
  );
}
