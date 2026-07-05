import { useState } from 'react';
import { api, ApiError, type AccountSummary } from '../api/client';
import { TestConnectionButton } from './TestConnectionButton';

/**
 * Discord is an "easy path" (t1): no app registration, no browser sign-in —
 * a webhook URL or bot token IS the credential (docs/AUTH.md §1 Discord).
 * Webhook is the default because it's the fastest for a streamer (created
 * from the channel's own settings, no Discord "app" involved at all).
 */
export function DiscordStep({ account, onConnected }: { account: AccountSummary | null; onConnected: (account: AccountSummary) => void }) {
  const [method, setMethod] = useState<'webhook' | 'bot'>('webhook');
  const [token, setToken] = useState('');
  const [channelName, setChannelName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!token.trim()) {
      setError(method === 'webhook' ? 'Paste your webhook URL first.' : 'Paste your bot token first.');
      return;
    }
    setBusy(true);
    try {
      const { account: created } = await api.pairWithToken({
        platformId: 'discord',
        token: token.trim(),
        tokenType: method,
        displayName: channelName.trim() || undefined,
      });
      setToken('');
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
          <strong>Connected:</strong> {account.displayName ?? account.handle ?? 'Discord account'}
        </p>
        <TestConnectionButton accountId={account.id} />
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Connect Discord</h3>
      <p>
        The quickest way is a <strong>webhook</strong> — a private posting address for one Discord channel. In Discord, open the
        channel you want announcements posted to, then <strong>Edit Channel → Integrations → Webhooks → New Webhook</strong>, and
        click <strong>Copy Webhook URL</strong>. Paste it below.
      </p>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 0.85rem' }}>
          <legend className="hint" style={{ padding: 0, marginBottom: '0.3rem' }}>
            How do you want to connect?
          </legend>
          <label className="checkbox-row">
            <input type="radio" name="discord-method" checked={method === 'webhook'} onChange={() => setMethod('webhook')} />
            Webhook URL (recommended — fastest)
          </label>
          <label className="checkbox-row">
            <input type="radio" name="discord-method" checked={method === 'bot'} onChange={() => setMethod('bot')} />
            Bot token (advanced — you already have a Discord bot)
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="discord-token">{method === 'webhook' ? 'Webhook URL' : 'Bot token'}</label>
          <input
            id="discord-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={method === 'webhook' ? 'https://discord.com/api/webhooks/…' : 'Paste your bot token'}
          />
          <span className="hint">This is kept encrypted and is never shown again after you save it.</span>
        </div>
        <div className="field">
          <label htmlFor="discord-channel-name">What should we call this connection? (optional)</label>
          <input id="discord-channel-name" value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder="e.g. #announcements" />
        </div>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect Discord'}
        </button>
      </form>
    </div>
  );
}
