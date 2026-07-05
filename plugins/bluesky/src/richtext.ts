/**
 * AT Protocol richtext helpers: grapheme counting, UTF-8 byte offsets, and
 * facet extraction (mentions / links / hashtags) for `app.bsky.feed.post`.
 *
 * AT Proto indexes facets by UTF-8 BYTE offset, not UTF-16 code unit or
 * grapheme index (docs.bsky.app/docs/advanced-guides/post-richtext: "Bluesky
 * uses UTF-8 code units to index facets... it uses byte offsets into UTF-8
 * encoded strings"). The `app.bsky.feed.post` lexicon caps `text` at
 * `maxGraphemes: 300` and `maxLength: 3000` (UTF-8 bytes) — see
 * https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json
 *
 * Never use `.length`/`.slice()` (UTF-16 code units) for facet math — a single
 * emoji or astral character desyncs byte offsets from character offsets.
 */

const encoder = new TextEncoder();

/** Number of Unicode extended grapheme clusters in `text` (what users perceive as "characters"). */
export function graphemeLength(text: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** UTF-8 byte length of `text`, matching the AT Proto `maxLength` field. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Converts a UTF-16 code-unit index (JS string index) into a UTF-8 byte offset. */
export function charIndexToByteOffset(text: string, charIndex: number): number {
  return encoder.encode(text.slice(0, charIndex)).length;
}

export type FacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string };

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: FacetFeature[];
}

interface RawMatch {
  charStart: number;
  charEnd: number;
  kind: 'link' | 'mention' | 'tag';
  value: string;
}

// Conservative, documented-shape patterns (mirrors the reference regexes in
// docs.bsky.app's richtext guide): URLs, @handle.domain mentions, #hashtags.
const URL_RE = /https?:\/\/[^\s]+[^\s.,;:!?)'"\]]/g;
const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;
const TAG_RE = /(^|\s)#([^\d\s][\w-]*)/gu;

/**
 * Scans plain text for URLs, @handle mentions, and #hashtags and returns their
 * UTF-16 char ranges (before byte conversion) plus the raw matched value.
 * Overlap is resolved by first-match-wins in scan order (links first, since a
 * mention-looking `@x.com` inside a URL should not also register as a mention).
 */
function scanMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  const covered: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) => covered.some(([s, e]) => start < e && end > s);

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    matches.push({ charStart: start, charEnd: end, kind: 'link', value: m[0] });
    covered.push([start, end]);
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const full = m[0];
    const handle = m[2];
    if (!handle) continue;
    const start = (m.index ?? 0) + (full.length - (1 + handle.length));
    const end = start + 1 + handle.length;
    if (overlaps(start, end)) continue;
    matches.push({ charStart: start, charEnd: end, kind: 'mention', value: handle });
    covered.push([start, end]);
  }
  for (const m of text.matchAll(TAG_RE)) {
    const full = m[0];
    const tag = m[2];
    if (!tag) continue;
    const start = (m.index ?? 0) + (full.length - (1 + tag.length));
    const end = start + 1 + tag.length;
    if (overlaps(start, end)) continue;
    matches.push({ charStart: start, charEnd: end, kind: 'tag', value: tag });
    covered.push([start, end]);
  }

  return matches.sort((a, b) => a.charStart - b.charStart);
}

/**
 * Builds byte-indexed facets for a finished post text. Mentions require a DID,
 * resolved by the caller via `resolveMentionDid` (com.atproto.identity.resolveHandle) —
 * a mention whose handle fails to resolve is dropped from the facet list (the
 * plain "@handle" text still renders, just without a clickable profile link).
 */
export async function buildFacets(
  text: string,
  resolveMentionDid: (handle: string) => Promise<string | undefined>,
): Promise<Facet[]> {
  const matches = scanMatches(text);
  const facets: Facet[] = [];

  for (const match of matches) {
    const byteStart = charIndexToByteOffset(text, match.charStart);
    const byteEnd = charIndexToByteOffset(text, match.charEnd);

    if (match.kind === 'link') {
      facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: match.value }] });
    } else if (match.kind === 'tag') {
      facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: match.value }] });
    } else {
      const did = await resolveMentionDid(match.value);
      if (did) {
        facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
      }
    }
  }

  return facets;
}

/**
 * Assembles the final post text from a `PostPayload`-shaped input: base text,
 * plus any structured hashtags/mentions not already present inline, appended
 * on trailing lines so they get their own facets. Idempotent — hashtags/
 * mentions already present verbatim in `text` are not duplicated.
 */
export function assembleText(text: string | undefined, tags: string[] | undefined, mentions: string[] | undefined): string {
  const base = text ?? '';
  const extras: string[] = [];

  for (const tag of tags ?? []) {
    const token = `#${tag}`;
    if (!base.includes(token)) extras.push(token);
  }
  for (const mention of mentions ?? []) {
    const token = `@${mention}`;
    if (!base.includes(token)) extras.push(token);
  }

  if (extras.length === 0) return base;
  return base.length > 0 ? `${base}\n\n${extras.join(' ')}` : extras.join(' ');
}
