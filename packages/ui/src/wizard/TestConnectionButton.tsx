import { useState } from 'react';
import { api } from '../api/client';

/**
 * Per-account "Test this connection" button (t1 requirement). Backed by
 * `POST /api/accounts/:id/test`, which always resolves with a plain-language
 * `{ ok, message }` rather than throwing — this button never shows a raw
 * error/stack trace, only what the API already translated.
 */
export function TestConnectionButton({ accountId }: { accountId: string }) {
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function run(): Promise<void> {
    setState('checking');
    setMessage(null);
    try {
      const result = await api.testAccount(accountId);
      setState(result.ok ? 'ok' : 'failed');
      setMessage(result.message);
    } catch (err) {
      setState('failed');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <button type="button" className="btn secondary" onClick={() => void run()} disabled={state === 'checking'}>
        {state === 'checking' ? 'Testing…' : 'Test this connection'}
      </button>
      {message && (
        <p role="status" className="hint" style={{ color: state === 'ok' ? 'var(--success)' : 'var(--danger)', marginTop: '0.4rem' }}>
          {message}
        </p>
      )}
    </div>
  );
}
