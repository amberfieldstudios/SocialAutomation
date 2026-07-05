import { useEffect, useState } from 'react';
import { api, type AccountSummary, ApiError } from '../api/client';
import { Badge } from '../components/Badge';

const PLATFORM_LABELS: Record<string, string> = {
  discord: 'Discord',
  twitch: 'Twitch',
  bluesky: 'Bluesky',
  reddit: 'Reddit',
  mastodon: 'Mastodon',
};

export function AccountsView({ onRunSetupAgain }: { onRunSetupAgain?: () => void } = {}) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [platformId, setPlatformId] = useState('discord');
  const [remoteId, setRemoteId] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');

  async function refresh(): Promise<void> {
    try {
      const { accounts: list } = await api.listAccounts();
      setAccounts(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleReconnect(id: string): Promise<void> {
    setBusyId(id);
    try {
      await api.reconnectAccount(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(id: string, label: string): Promise<void> {
    if (!window.confirm(`Remove connected account "${label}"? This cannot be undone.`)) return;
    setBusyId(id);
    try {
      await api.removeAccount(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (!remoteId.trim()) {
      setFormError('Remote account id is required.');
      return;
    }
    try {
      await api.addAccount({
        platformId,
        remoteId: remoteId.trim(),
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setRemoteId('');
      setHandle('');
      setDisplayName('');
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Connected accounts</h2>
      <p className="hint">
        Manage the platforms you've connected here, or add one using the form below. New to SocialAutomation? The Setup
        wizard walks through connecting each platform step by step.
      </p>
      {onRunSetupAgain && (
        <p>
          <button type="button" className="btn secondary" onClick={onRunSetupAgain}>
            Run setup again
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="card">
        <button type="button" className="btn secondary" aria-expanded={formOpen} onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? 'Cancel' : 'Add account'}
        </button>
        {formOpen && (
          <form onSubmit={handleAdd} style={{ marginTop: '0.75rem' }} aria-label="Add a connected account">
            <div className="field">
              <label htmlFor="acct-platform">Platform</label>
              <select id="acct-platform" value={platformId} onChange={(e) => setPlatformId(e.target.value)}>
                {Object.entries(PLATFORM_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="acct-remote-id">Remote account id</label>
              <input id="acct-remote-id" value={remoteId} onChange={(e) => setRemoteId(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="acct-handle">Handle</label>
              <input id="acct-handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="acct-display-name">Display name</label>
              <input id="acct-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            {formError && <p role="alert" style={{ color: 'var(--danger)' }}>{formError}</p>}
            <button type="submit" className="btn">
              Add
            </button>
          </form>
        )}
      </div>

      {accounts === null ? (
        <p>Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <p className="empty-state">No accounts connected yet.</p>
      ) : (
        <table>
          <caption className="sr-only">Connected accounts by platform</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Platform</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {account.avatarUrl && (
                      <img
                        src={account.avatarUrl}
                        alt=""
                        width={28}
                        height={28}
                        style={{ borderRadius: '50%' }}
                      />
                    )}
                    <div>
                      <div>{account.displayName ?? account.handle ?? account.remoteId}</div>
                      {account.handle && <div className="hint">@{account.handle}</div>}
                    </div>
                  </div>
                </th>
                <td>{PLATFORM_LABELS[account.platformId] ?? account.platformId}</td>
                <td>
                  <Badge status={account.status} />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {account.status === 'disconnected' && (
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busyId === account.id}
                        onClick={() => void handleReconnect(account.id)}
                      >
                        Reconnect
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busyId === account.id}
                      onClick={() => void handleRemove(account.id, account.displayName ?? account.handle ?? account.id)}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
