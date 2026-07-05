/**
 * Length-counting and text-assembly helpers shared by `CampaignGenerator` and
 * both providers. Grapheme-aware where a platform requires it (Bluesky counts
 * Unicode extended grapheme clusters, not UTF-16 code units — see
 * docs/PLATFORM-RULES.md § Bluesky) so a truncation never lands mid-emoji.
 */

/** Split `text` into extended grapheme clusters via `Intl.Segmenter` (Node 22+). */
function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Length of `text` in the unit the platform counts: graphemes or UTF-16 code units. */
export function measureLength(text: string, countGraphemes = false): number {
  return countGraphemes ? graphemes(text).length : text.length;
}

/**
 * Truncate `text` to at most `maxLength` units (graphemes or UTF-16 code
 * units), preferring a word boundary so we don't cut mid-word when there's
 * room to spare. Always the final safety net before a variant is returned —
 * never trust a provider's self-reported length.
 */
export function truncateToLimit(text: string, maxLength: number, countGraphemes = false): string {
  if (maxLength <= 0) return '';
  const trimmed = text.trim();
  if (measureLength(trimmed, countGraphemes) <= maxLength) return trimmed;

  if (countGraphemes) {
    const units = graphemes(trimmed);
    const cut = units.slice(0, maxLength).join('');
    return backOffToWordBoundary(cut, maxLength);
  }
  const cut = trimmed.slice(0, maxLength);
  return backOffToWordBoundary(cut, maxLength);
}

function backOffToWordBoundary(cut: string, maxLength: number): string {
  // Only back off to a word boundary if it doesn't throw away more than ~20%
  // of the budget — otherwise a hard cut is better than a tiny fragment.
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.8) {
    return cut.slice(0, lastSpace).trimEnd();
  }
  return cut.trimEnd();
}

/**
 * Append `suffix` to `base` (separated by `separator`) only if the combined
 * result fits within `maxLength`; otherwise truncates `base` to make room.
 * Never exceeds `maxLength` even if `suffix` alone is longer than the limit
 * (in that pathological case `suffix` itself is truncated).
 */
export function appendWithinLimit(
  base: string,
  suffix: string,
  maxLength: number,
  countGraphemes = false,
  separator = ' ',
): string {
  if (!suffix) return base;
  const sepLen = measureLength(separator, countGraphemes);
  const suffixLen = measureLength(suffix, countGraphemes);
  if (suffixLen + sepLen >= maxLength) {
    // No room for base at all — return the (truncated) suffix alone.
    return truncateToLimit(suffix, maxLength, countGraphemes);
  }
  const budgetForBase = maxLength - suffixLen - sepLen;
  const truncatedBase = truncateToLimit(base, budgetForBase, countGraphemes);
  return `${truncatedBase}${separator}${suffix}`;
}

/** Collapse runs of whitespace and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Rules for cleaning a single hashtag candidate. */
export interface HashtagRules {
  /** Only letters/digits/underscore, must start with a letter or digit, 1-25
   * chars — Twitch's channel-tag charset (docs/PLATFORM-RULES.md § Twitch). */
  strict?: boolean;
  maxLength?: number;
}

/** Strip a leading '#', then sanitize a hashtag candidate; returns null if nothing usable remains. */
export function sanitizeHashtag(raw: string, rules: HashtagRules = {}): string | null {
  const maxLength = rules.maxLength ?? (rules.strict ? 25 : 40);
  let tag = raw.trim().replace(/^#+/, '');
  tag = rules.strict ? tag.replace(/[^A-Za-z0-9_]/g, '') : tag.replace(/[^\p{L}\p{N}_]/gu, '');
  if (rules.strict && tag.length > 0 && !/^[A-Za-z0-9]/.test(tag)) {
    // Must start with a letter or digit — drop leading underscores.
    tag = tag.replace(/^_+/, '');
  }
  tag = tag.slice(0, maxLength);
  return tag.length > 0 ? tag : null;
}

/** Sanitize, dedupe (case-insensitively), and cap a list of hashtag candidates. */
export function sanitizeHashtags(raw: string[], max: number, rules: HashtagRules = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (out.length >= max) break;
    const tag = sanitizeHashtag(candidate, rules);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Strip a leading '@' and drop anything left empty; dedupe case-insensitively. */
export function sanitizeMentions(raw: string[], max?: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (max !== undefined && out.length >= max) break;
    const mention = candidate.trim().replace(/^@+/, '');
    if (!mention) continue;
    const key = mention.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
  }
  return out;
}

/** Split provider free-text hashtag/keyword output into candidate tokens. */
export function splitCandidates(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Mirrors `BlueskyConnector`'s `assembleText()` idempotent-extras algorithm
 * (plugins/bluesky/src/richtext.ts `assembleText`, kept in sync per
 * docs/PLATFORM-RULES.md § Bluesky): given a finished body plus hashtag/mention
 * arrays, returns exactly the suffix a connector using that idiom would still
 * need to append — empty if every `#tag`/`@mention` is already present
 * verbatim in `body`. `CampaignGenerator` uses this BOTH to reserve budget
 * before generation and, as a final bulletproof check, to confirm the
 * generated payload's assembled length can never exceed the platform limit
 * even though the actual appending happens downstream in the connector.
 */
export function assembledExtrasFootprint(body: string, tags: string[] | undefined, mentions: string[] | undefined): string {
  const extras: string[] = [];
  for (const tag of tags ?? []) {
    const token = `#${tag}`;
    if (!body.includes(token)) extras.push(token);
  }
  for (const mention of mentions ?? []) {
    const token = `@${mention}`;
    if (!body.includes(token)) extras.push(token);
  }
  if (extras.length === 0) return '';
  return body.length > 0 ? `\n\n${extras.join(' ')}` : extras.join(' ');
}
