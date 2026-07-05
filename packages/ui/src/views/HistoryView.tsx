import { useEffect, useState } from 'react';
import { api, type HistoryEntry } from '../api/client';
import { Badge } from '../components/Badge';

export function HistoryView() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listHistory()
      .then((r) => setEntries(r.entries))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading">Publish history</h2>
      <p className="hint">Per-post results across every campaign and platform.</p>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {entries === null ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty-state">No published posts yet.</p>
      ) : (
        <table>
          <caption className="sr-only">Publish history</caption>
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Platform</th>
              <th scope="col">Account</th>
              <th scope="col">Text</th>
              <th scope="col">Status</th>
              <th scope="col">Published</th>
              <th scope="col">Link</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.variantId}>
                <td>{entry.campaignId ?? '—'}</td>
                <td>{entry.platformId}</td>
                <td>{entry.accountHandle ?? entry.accountId}</td>
                <td style={{ maxWidth: '20rem' }}>{entry.text ?? '—'}</td>
                <td>
                  <Badge status={entry.status} />
                </td>
                <td>{entry.publishedAt ? new Date(entry.publishedAt).toLocaleString() : '—'}</td>
                <td>
                  {entry.remoteUrl ? (
                    <a href={entry.remoteUrl} target="_blank" rel="noreferrer">
                      View
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
