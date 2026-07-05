/**
 * UTM parameter builder.
 *
 * Given a base URL + campaign metadata, produces a URL with `utm_*` query
 * parameters set. Uses the WHATWG `URL`/`URLSearchParams` API so encoding is
 * always correct (spaces, `&`, unicode, etc.) and existing non-UTM query
 * params + the fragment are preserved untouched.
 *
 * Idempotent: `URLSearchParams.set()` overwrites (and de-duplicates) any
 * existing value for the same key, so tagging an already-tagged URL replaces
 * the old UTM values instead of stacking a second copy of the params.
 */

export interface UtmParams {
  /** `utm_source` — where the traffic originates, e.g. the platform id (`twitch`, `bluesky`). */
  source: string;
  /** `utm_medium` — the marketing medium, e.g. `social`. */
  medium: string;
  /** `utm_campaign` — the campaign identifier/tracking code. */
  campaign: string;
  /** `utm_content` — differentiates variants of the same campaign/ad, e.g. accountId. */
  content?: string;
  /** `utm_term` — paid-search keyword equivalent; rarely used for social but supported. */
  term?: string;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

/**
 * Tag `baseUrl` with `utm_*` query parameters. Throws if `baseUrl` is not a
 * valid absolute URL (callers should validate/guard upstream — a link that
 * can't even parse as a URL has no business going out to a platform).
 */
export function buildUtmUrl(baseUrl: string, params: UtmParams): string {
  const url = new URL(baseUrl);
  url.searchParams.set('utm_source', params.source);
  url.searchParams.set('utm_medium', params.medium);
  url.searchParams.set('utm_campaign', params.campaign);
  if (params.content !== undefined) url.searchParams.set('utm_content', params.content);
  if (params.term !== undefined) url.searchParams.set('utm_term', params.term);
  return url.toString();
}

/** True if `url` already carries at least a `utm_source` and `utm_campaign` pair. */
export function isUtmTagged(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has('utm_source') && parsed.searchParams.has('utm_campaign');
  } catch {
    return false;
  }
}

/** Strip every `utm_*` parameter from `url`, returning the bare link. */
export function stripUtm(url: string): string {
  const parsed = new URL(url);
  for (const key of UTM_KEYS) parsed.searchParams.delete(key);
  return parsed.toString();
}
