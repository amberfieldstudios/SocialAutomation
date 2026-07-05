import { useEffect, useRef, useState } from 'react';
import { api, type AccountSummary, type PlatformInfo, type PlatformPreviewResult } from '../api/client';

interface TargetSelection {
  platformId: string;
  accountId: string;
}

/** Strips an optional leading "r/"/"/r/" and surrounding whitespace, so "r/Twitch" and "Twitch" both work. */
function normalizeSubreddit(value: string): string {
  return value.trim().replace(/^\/?r\//i, '').trim();
}

/** Attaches the Reddit subreddit (t14) to every selected Reddit target; other platforms pass through unchanged. */
function withPlatformOptions(
  targets: TargetSelection[],
  redditSubreddit: string,
): { platformId: string; accountId: string; platformOptions?: Record<string, unknown> }[] {
  const subreddit = normalizeSubreddit(redditSubreddit);
  return targets.map((t) =>
    t.platformId === 'reddit' && subreddit ? { ...t, platformOptions: { subreddit } } : t,
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function ComposerView() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [description, setDescription] = useState('');
  const [cta, setCta] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState<TargetSelection[]>([]);
  const [redditSubreddit, setRedditSubreddit] = useState('');
  const [previews, setPreviews] = useState<PlatformPreviewResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    void api.listPlatforms().then((r) => setPlatforms(r.platforms));
    void api.listAccounts().then((r) => setAccounts(r.accounts));
  }, []);

  const debouncedDescription = useDebouncedValue(description, 400);
  const debouncedCta = useDebouncedValue(cta, 400);
  const debouncedLink = useDebouncedValue(link, 400);
  const debouncedRedditSubreddit = useDebouncedValue(redditSubreddit, 400);
  const hasRedditTarget = selected.some((t) => t.platformId === 'reddit');

  function toggleTarget(platformId: string, accountId: string): void {
    setSelected((prev) => {
      const exists = prev.some((t) => t.platformId === platformId && t.accountId === accountId);
      return exists
        ? prev.filter((t) => !(t.platformId === platformId && t.accountId === accountId))
        : [...prev, { platformId, accountId }];
    });
  }

  useEffect(() => {
    const thisRequest = ++requestId.current;
    if (!debouncedDescription.trim() || selected.length === 0) {
      setPreviews(null);
      return;
    }
    setLoading(true);
    setPreviewError(null);
    api
      .composePreview({
        description: debouncedDescription,
        ...(debouncedCta.trim() ? { cta: debouncedCta.trim() } : {}),
        ...(debouncedLink.trim() ? { link: debouncedLink.trim() } : {}),
        platforms: withPlatformOptions(selected, debouncedRedditSubreddit),
      })
      .then((res) => {
        if (requestId.current === thisRequest) setPreviews(res.results);
      })
      .catch((err) => {
        if (requestId.current === thisRequest) setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestId.current === thisRequest) setLoading(false);
      });
  }, [debouncedDescription, debouncedCta, debouncedLink, debouncedRedditSubreddit, JSON.stringify(selected)]);

  async function handleSubmit(): Promise<void> {
    setSubmitStatus(null);
    try {
      const res = await api.submitCampaign({
        description,
        ...(cta.trim() ? { cta: cta.trim() } : {}),
        ...(link.trim() ? { link: link.trim() } : {}),
        platforms: withPlatformOptions(selected, redditSubreddit),
      });
      const enqueued = res.results.filter((r) => r.status === 'enqueued').length;
      const rejected = res.results.filter((r) => r.status === 'rejected').length;
      const errored = res.results.filter((r) => r.status === 'error').length;
      setSubmitStatus(`Submitted: ${enqueued} enqueued, ${rejected} rejected, ${errored} errored.`);
    } catch (err) {
      setSubmitStatus(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const canSubmit =
    description.trim().length > 0 &&
    selected.length > 0 &&
    !loading &&
    (!hasRedditTarget || normalizeSubreddit(redditSubreddit).length > 0);

  return (
    <section aria-labelledby="composer-heading">
      <h2 id="composer-heading">Campaign composer</h2>
      <p className="hint">
        Write one description. Previews below are generated live by the AI stage's <code>MockProvider</code> (no
        API key, deterministic, network-free) and validated against each platform's real{' '}
        <code>validatePost</code> rules — nothing is published until you submit.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="composer-description">Content description</label>
          <textarea
            id="composer-description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby="composer-description-hint"
          />
          <span id="composer-description-hint" className="hint">
            The one brief every platform's variant is generated from.
          </span>
        </div>
        <div className="field">
          <label htmlFor="composer-cta">Call to action (optional)</label>
          <input id="composer-cta" value={cta} onChange={(e) => setCta(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="composer-link">Link (optional)</label>
          <input id="composer-link" type="url" value={link} onChange={(e) => setLink(e.target.value)} />
        </div>

        <fieldset className="field">
          <legend>Target accounts</legend>
          {platforms.length === 0 && <p className="hint">No platforms loaded.</p>}
          {platforms.map((platform) => {
            const platformAccounts = accounts.filter((a) => a.platformId === platform.id && a.status === 'active');
            return (
              <div key={platform.id}>
                <strong>{platform.capabilities.displayName}</strong>
                {platformAccounts.length === 0 && <p className="hint">No active accounts for this platform.</p>}
                {platformAccounts.map((account) => {
                  const id = `target-${platform.id}-${account.id}`;
                  const checked = selected.some((t) => t.platformId === platform.id && t.accountId === account.id);
                  return (
                    <div className="checkbox-row" key={id}>
                      <input
                        type="checkbox"
                        id={id}
                        checked={checked}
                        onChange={() => toggleTarget(platform.id, account.id)}
                      />
                      <label htmlFor={id}>{account.displayName ?? account.handle ?? account.remoteId}</label>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </fieldset>

        {hasRedditTarget && (
          <div className="field">
            <label htmlFor="composer-reddit-subreddit">Which subreddit?</label>
            <input
              id="composer-reddit-subreddit"
              value={redditSubreddit}
              onChange={(e) => setRedditSubreddit(e.target.value)}
              placeholder="e.g. Twitch"
              aria-describedby="composer-reddit-subreddit-hint"
            />
            <span id="composer-reddit-subreddit-hint" className="hint">
              Reddit posts go to one community. Type its name without "r/" — e.g. type "Twitch" to post to r/Twitch.
              Required to submit to Reddit.
            </span>
          </div>
        )}

        <button type="button" className="btn" disabled={!canSubmit} onClick={() => void handleSubmit()}>
          Submit campaign
        </button>
        {submitStatus && (
          <p role="status" style={{ marginTop: '0.6rem' }}>
            {submitStatus}
          </p>
        )}
      </div>

      <h3>Live previews</h3>
      <div aria-live="polite">
        {loading && <p>Generating previews…</p>}
        {previewError && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {previewError}
          </p>
        )}
        {!loading && !previewError && previews === null && (
          <p className="empty-state">Enter a description and select at least one account to see previews.</p>
        )}
      </div>

      {previews && (
        <div className="preview-grid">
          {previews.map((preview, i) => (
            <PreviewCard key={`${preview.platform}-${preview.accountId}-${i}`} preview={preview} />
          ))}
        </div>
      )}
    </section>
  );
}

function PreviewCard({ preview }: { preview: PlatformPreviewResult }) {
  const pct = preview.characterLimit && preview.textLength ? Math.min(100, (preview.textLength / preview.characterLimit) * 100) : 0;
  const over = preview.characterLimit !== undefined && preview.textLength !== undefined && preview.textLength > preview.characterLimit;

  return (
    <article className="card" aria-label={`Preview for ${preview.platform}`}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h4 style={{ margin: 0, textTransform: 'capitalize' }}>{preview.platform}</h4>
        <span className={`badge status-${preview.status}`}>{preview.status}</span>
      </header>

      {preview.status === 'error' ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {preview.error}
        </p>
      ) : (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{preview.payload?.text ?? preview.payload?.title}</p>
          {preview.characterLimit !== undefined && (
            <>
              <div
                className={`meter${over ? ' over' : ''}`}
                role="progressbar"
                aria-valuenow={preview.textLength ?? 0}
                aria-valuemin={0}
                aria-valuemax={preview.characterLimit}
                aria-label={`Character count for ${preview.platform}`}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
              <p className="hint">
                {preview.textLength} / {preview.characterLimit} characters
              </p>
            </>
          )}
          {preview.validation && (preview.validation.errors.length > 0 || preview.validation.warnings.length > 0) && (
            <ul className="issue-list">
              {preview.validation.errors.map((issue, i) => (
                <li key={`e-${i}`} className="error">
                  {issue.message}
                </li>
              ))}
              {preview.validation.warnings.map((issue, i) => (
                <li key={`w-${i}`} className="warning">
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}
