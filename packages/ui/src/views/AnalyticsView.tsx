import { useEffect, useState } from 'react';
import { api, type CampaignAnalyticsSummary, type CampaignSummary } from '../api/client';

// Okabe-Ito colorblind-safe qualitative palette.
const METRIC_COLORS: Record<string, string> = {
  views: '#0072B2',
  likes: '#E69F00',
  comments: '#009E73',
  shares: '#CC79A7',
  clicks: '#56B4E9',
};

export function AnalyticsView() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState<string>('');
  const [summary, setSummary] = useState<CampaignAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listCampaigns().then((r) => {
      setCampaigns(r.campaigns);
      if (r.campaigns[0]) setCampaignId(r.campaigns[0].id);
    });
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    setError(null);
    api
      .campaignAnalytics(campaignId)
      .then((r) => setSummary(r.summary))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [campaignId]);

  const metricEntries = summary ? Object.entries(summary.totals) : [];
  const maxValue = Math.max(1, ...metricEntries.map(([, v]) => v));

  return (
    <section aria-labelledby="analytics-heading">
      <h2 id="analytics-heading">Campaign analytics</h2>

      <div className="field" style={{ maxWidth: '20rem' }}>
        <label htmlFor="analytics-campaign">Campaign</label>
        <select id="analytics-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          {campaigns.length === 0 && <option value="">No campaigns yet</option>}
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {summary && (
        <>
          <div className="stat-row" role="group" aria-label="Campaign totals">
            <div className="stat-tile">
              <div className="value">{summary.snapshotCount}</div>
              <div className="label">Snapshots</div>
            </div>
            <div className="stat-tile">
              <div className="value">{summary.postVariantCount}</div>
              <div className="label">Posts</div>
            </div>
            <div className="stat-tile">
              <div className="value">{summary.platforms.length}</div>
              <div className="label">Platforms</div>
            </div>
            {summary.ctr !== undefined && (
              <div className="stat-tile">
                <div className="value">{(summary.ctr * 100).toFixed(1)}%</div>
                <div className="label">CTR</div>
              </div>
            )}
          </div>

          <h3>Metric totals</h3>
          {metricEntries.length === 0 ? (
            <p className="empty-state">No analytics collected for this campaign yet.</p>
          ) : (
            <>
              {/* Table is the primary, accessible data source; the bar beside each row is a
                  decorative visual enhancement (aria-hidden) using an Okabe-Ito colorblind-safe palette. */}
              <table>
                <caption className="sr-only">Metric totals for {summary.campaignId}</caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Total</th>
                    <th scope="col">
                      <span className="sr-only">Relative size</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metricEntries.map(([metric, value]) => (
                    <tr key={metric}>
                      <th scope="row" style={{ fontWeight: 400, textTransform: 'capitalize' }}>
                        {metric}
                      </th>
                      <td>{value.toLocaleString()}</td>
                      <td style={{ width: '40%' }}>
                        <div
                          aria-hidden="true"
                          style={{
                            height: '0.9rem',
                            width: `${(value / maxValue) * 100}%`,
                            minWidth: '2px',
                            background: METRIC_COLORS[metric] ?? '#666',
                            borderRadius: '3px',
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">Platforms: {summary.platforms.join(', ')}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
