import { useState } from 'react';
import { api, ApiError, type AccountSummary } from '../api/client';
import { TestConnectionButton } from './TestConnectionButton';

/**
 * Bluesky is an "easy path" (t1): a handle + a single-purpose "app password"
 * (docs/AUTH.md §1 Bluesky) — no browser sign-in window, no app registration.
 */
export function BlueskyStep({ account, onConnected }: { account: AccountSummary | null; onConnected: (account: AccountSummary) => void }) {
  const [handle, setHandle] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!handle.trim() || !appPassword.trim()) {
      setError('Enter your handle and an app password.');
      return;
    }
    setBusy(true);
    try {
      const { account: created } = await api.pairWithPassword({
        platformId: 'bluesky',
        identifier: handle.trim(),
        password: appPassword.trim(),
      });
      setAppPassword('');
      onConnected(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (account) {
    return (
      <div className="card">
        <p>
          <strong>Connected:</strong> {account.displayName ?? account.handle ?? 'Bluesky account'}
        </p>
        <TestConnectionButton accountId={account.id} />
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Connect Bluesky</h3>
      <p>
        Bluesky lets you create a special password just for apps like this one, so you never have to share your real
        password. In the Bluesky app or website, go to <strong>Settings → App Passwords → Add App Password</strong>, name it
        anything (e.g. "SocialAutomation"), and copy the password it shows you — you'll only see it once.
      </p>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="field">
          <label htmlFor="bsky-handle">Your Bluesky handle</label>
          <input id="bsky-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="you.bsky.social" autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="bsky-app-password">App password</label>
          <input
            id="bsky-app-password"
            type="password"
            autoComplete="new-password"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            placeholder="xxxx-xxxx-xxxx-xxxx"
          />
          <span className="hint">
            Not your normal Bluesky password — the app password from Settings → App Passwords. It's kept encrypted.
          </span>
        </div>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect Bluesky'}
        </button>
      </form>
    </div>
  );
}
