import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AccountSummary } from '../api/client';
import { TestConnectionButton } from './TestConnectionButton';
import { OAUTH_EXPLAINER, type GuidedPlatformCopy } from './wizardCopy';

type Phase = 'register' | 'connecting' | 'connected';

/**
 * Twitch / Reddit / Mastodon (t1): these platforms require a one-time,
 * free "app" registration before SocialAutomation can connect (docs/AUTH.md
 * §10.5) — this component walks that registration step by step, then drives
 * the redirect ("sign in on the platform's own site") pairing flow.
 *
 * Redirect completion happens server-side (the platform sends the browser
 * back to THIS server's callback route, not to this tab — see
 * `packages/api/src/pairing-routes.ts`), so after opening the sign-in window
 * this component polls `GET /api/accounts/pair/poll/:state` for the outcome.
 */
export function RedirectConnectStep({
  copy,
  account,
  onConnected,
}: {
  copy: GuidedPlatformCopy;
  account: AccountSummary | null;
  onConnected: (account: AccountSummary) => void;
}) {
  const redirectUri = `${window.location.origin}/api/accounts/pair/callback/${copy.id}`;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('register');
  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getAppCredentialsStatus(copy.id).then((status) => {
      if (!cancelled) setConfigured(status.configured);
    });
    return () => {
      cancelled = true;
    };
  }, [copy.id]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function copyToClipboard(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard permission denied — the field is still selectable/copyable by hand.
    }
  }

  async function handleSaveCredentials(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!clientId.trim()) {
      setError('Paste the app ID (Client ID) you copied from the platform.');
      return;
    }
    if (copy.secretRequired && !clientSecret.trim()) {
      setError('Paste the app secret you copied from the platform.');
      return;
    }
    if (copy.needsInstanceUrl && !instanceUrl.trim()) {
      setError('Enter your Mastodon server address first.');
      return;
    }
    setSaving(true);
    try {
      await api.saveAppCredentials({
        platformId: copy.id,
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        redirectUri,
        ...(instanceUrl.trim() ? { instanceUrl: normalizeInstanceUrl(instanceUrl) } : {}),
      });
      setConfigured(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect(): Promise<void> {
    setError(null);
    setPhase('connecting');
    setConnectMessage('Waiting for you to approve access in the window that just opened…');
    try {
      const result = await api.beginPairing({ platformId: copy.id, operations: ['publish'] });
      if (result.kind !== 'authorize_url') {
        setError("This platform needs a connection method the wizard doesn't support yet.");
        setPhase('register');
        return;
      }
      window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer');
      const state = result.state;
      pollRef.current = setInterval(() => {
        void api.pollPairing(state).then((outcome) => {
          if (outcome.status === 'pending') return;
          if (pollRef.current) clearInterval(pollRef.current);
          if (outcome.status === 'succeeded') {
            setPhase('connected');
            setConnectMessage(null);
            onConnected(outcome.account);
          } else {
            setPhase('register');
            setConnectMessage(null);
            setError(outcome.message);
          }
        });
      }, 2000);
    } catch (err) {
      setPhase('register');
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (account || phase === 'connected') {
    return (
      <div className="card">
        <p>
          <strong>Connected:</strong> {account?.displayName ?? account?.handle ?? `${copy.label} account`}
        </p>
        {account && <TestConnectionButton accountId={account.id} />}
      </div>
    );
  }

  const consoleUrl = copy.needsInstanceUrl
    ? instanceUrl.trim()
      ? `https://${normalizeInstanceUrl(instanceUrl)}/settings/applications`
      : ''
    : copy.consoleUrl;

  return (
    <div className="card">
      <h3>Connect {copy.label}</h3>
      <p>{copy.blurb}</p>

      {copy.needsInstanceUrl && (
        <div className="field">
          <label htmlFor={`${copy.id}-instance`}>Your Mastodon server address</label>
          <input
            id={`${copy.id}-instance`}
            value={instanceUrl}
            onChange={(e) => setInstanceUrl(e.target.value)}
            placeholder="mastodon.social"
          />
          <span className="hint">This is the part of your Mastodon handle after the @ — e.g. @you@mastodon.social → "mastodon.social".</span>
        </div>
      )}

      {configured === false && (!copy.needsInstanceUrl || instanceUrl.trim()) && (
        <>
          <ol>
            {copy.registrationSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <div className="field">
            <label htmlFor={`${copy.id}-redirect-uri`}>Address to paste into the redirect field</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input id={`${copy.id}-redirect-uri`} readOnly value={redirectUri} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn secondary" onClick={() => void copyToClipboard(redirectUri)}>
                Copy
              </button>
            </div>
          </div>
          {consoleUrl && (
            <p>
              <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
                Open {copy.consoleLabel} in a new tab ↗
              </a>
            </p>
          )}
          <form onSubmit={(e) => void handleSaveCredentials(e)}>
            <div className="field">
              <label htmlFor={`${copy.id}-client-id`}>App ID (Client ID)</label>
              <input id={`${copy.id}-client-id`} value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </div>
            {copy.secretRequired && (
              <div className="field">
                <label htmlFor={`${copy.id}-client-secret`}>App secret (Client Secret)</label>
                <input
                  id={`${copy.id}-client-secret`}
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <span className="hint">Kept encrypted, never shown again after you save it.</span>
              </div>
            )}
            {error && (
              <p role="alert" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save app details'}
            </button>
          </form>
        </>
      )}

      {configured && phase === 'register' && (
        <>
          <p className="hint">{OAUTH_EXPLAINER}</p>
          {error && (
            <p role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={() => void handleConnect()}>
              Connect {copy.label}
            </button>
            <button type="button" className="btn secondary" onClick={() => setConfigured(false)}>
              Edit app details
            </button>
          </div>
        </>
      )}

      {phase === 'connecting' && (
        <p role="status" className="hint">
          {connectMessage}
        </p>
      )}
    </div>
  );
}

function normalizeInstanceUrl(value: string): string {
  return value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
