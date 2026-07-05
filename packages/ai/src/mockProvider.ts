/**
 * `MockProvider` — the deterministic, network-free, zero-key `ContentProvider`.
 *
 * TWO jobs, one implementation:
 *  1. TEST DOUBLE: every method is a pure function of its input — same task in,
 *     same text out, every time — so the whole monorepo's tests use it instead
 *     of a real model. No API key, no network, no flakiness.
 *  2. HONEST TEMPLATE FALLBACK (task t5): it is also the credential-free
 *     GENERATION fallback the running app uses whenever the on-device model is
 *     absent, still downloading, or the machine is too weak to load it (the
 *     `FallbackContentProvider` degrades to it when `LocalProvider` throws).
 *     Because real users see this output, it must be genuinely usable copy —
 *     NOT lorem-ipsum and NOT keyword-stuffed padding. It therefore composes
 *     posts from the author's OWN brief fields (title, description, cta, tags)
 *     and NEVER invents facts absent from the brief, never repeats words to hit
 *     a length target, and never leaks prompt/tone-instruction text into the
 *     output. It cannot creatively paraphrase like an LLM, so it leans on the
 *     brief's real content and clean formatting instead.
 *
 * All per-platform shaping (character clamping, hashtag/emoji/CTA/title/link
 * assembly) is `CampaignGenerator`'s job — this provider only produces the raw
 * text for each `ContentTaskKind`.
 */

import type { ContentGenerationTask, ContentProvider } from './types';
import { measureLength, normalizeWhitespace, splitCandidates, truncateToLimit } from './text';

/** Deterministic "hash" used only to pick a stable emoji/closer index — not for security. */
function stableIndex(seed: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % Math.max(1, modulo);
}

const EMOJI_BANK = ['✨', '\u{1F525}', '\u{1F680}', '\u{1F3AE}', '\u{1F4E3}', '✅', '\u{1F440}', '\u{1F3AF}'];

/**
 * Generic, fact-free engagement closers used ONLY as a last resort by
 * `expand()` to reach a length target when the brief has no further real
 * detail to fold in. They add no claims about the subject (no invented facts) —
 * they are the kind of neutral invitation a human writes to round out a short
 * post. Deterministically ordered so output stays reproducible.
 */
const EXPANSION_CLOSERS = ['Come check it out.', 'Hope to see you there.', "Don't miss it."];

function pickEmoji(seed: string): string {
  const e = EMOJI_BANK[stableIndex(seed, EMOJI_BANK.length)];
  return e ?? EMOJI_BANK[0]!;
}

function significantWords(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'at', 'this', 'that',
  ]);
  return normalizeWhitespace(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !stopwords.has(w));
}

/** True if `haystack` already contains `needle` (case-insensitive, whitespace-normalized). */
function looseIncludes(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return normalizeWhitespace(haystack).toLowerCase().includes(normalizeWhitespace(needle).toLowerCase());
}

/** Ensure `text` reads as a sentence (ends with terminal punctuation). */
function asSentence(text: string): string {
  const t = normalizeWhitespace(text);
  if (!t) return t;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * Compose an honest post body from the brief. The description is the core
 * message; if the author supplied a distinct title/headline it becomes a short
 * lead sentence in front of it. No padding, no repetition, no invented detail —
 * a short brief yields short (but genuine and usable) copy.
 */
function renderBody(task: ContentGenerationTask): string {
  const { brief } = task;
  const description = normalizeWhitespace(brief.description);

  // Lead with the author's title only when it adds something the description
  // doesn't already say — otherwise it would just be redundant restatement.
  if (brief.title) {
    const title = normalizeWhitespace(brief.title);
    if (title && !looseIncludes(description, title) && !looseIncludes(title, description)) {
      return normalizeWhitespace(`${asSentence(title)} ${description}`);
    }
  }
  return description;
}

function renderTitle(task: ContentGenerationTask): string {
  const { brief } = task;
  const seoPrefix = brief.seoKeywords && brief.seoKeywords.length > 0 ? `${brief.seoKeywords[0]}: ` : '';
  const base = brief.title ?? brief.description;
  return normalizeWhitespace(`${seoPrefix}${base}`);
}

function renderHashtags(task: ContentGenerationTask): string {
  const { brief } = task;
  const seeds = [...(brief.tags ?? []), ...significantWords(brief.description)];
  const max = task.maxHashtags ?? 5;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seed of seeds) {
    if (out.length >= max) break;
    const key = seed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seed);
  }
  return out.join(' ');
}

function renderCta(task: ContentGenerationTask): string {
  // Just the call-to-action phrase — the link is placed in the body by
  // `CampaignGenerator`, so repeating it here would duplicate the URL (and the
  // real Claude/OpenAI providers return a bare CTA phrase for this kind too).
  return normalizeWhitespace(task.brief.cta ?? 'Check it out');
}

function applyEmoji(sourceText: string, task: ContentGenerationTask): string {
  const emoji = pickEmoji(`${task.platform}:${sourceText}`);
  return `${emoji} ${sourceText}`;
}

/** Dispatch to the right deterministic renderer for `task.kind`. */
function renderByKind(task: ContentGenerationTask): string {
  switch (task.kind) {
    case 'title':
      return renderTitle(task);
    case 'hashtags':
      return renderHashtags(task);
    case 'cta':
      return renderCta(task);
    case 'emoji':
      return applyEmoji(task.sourceText ?? renderBody(task), task);
    case 'body':
    default:
      return renderBody(task);
  }
}

export class MockProvider implements ContentProvider {
  readonly name = 'mock';

  async generate(task: ContentGenerationTask): Promise<string> {
    return truncateToLimit(renderByKind(task), task.maxLength, task.countGraphemes);
  }

  async rewrite(task: ContentGenerationTask): Promise<string> {
    const base = normalizeWhitespace(task.sourceText ?? renderByKind(task));
    // The 'emoji' kind applies the deterministic emoji decoration. For every
    // other kind a template provider cannot honestly paraphrase, so it returns
    // the cleaned source unchanged — crucially WITHOUT prepending any
    // tone-instruction text (a real LLM rephrase is ClaudeProvider's job). This
    // keeps output free of leaked prompt scaffolding.
    const rewritten = task.kind === 'emoji' ? applyEmoji(base, task) : base;
    return truncateToLimit(rewritten, task.maxLength, task.countGraphemes);
  }

  async shorten(task: ContentGenerationTask): Promise<string> {
    const base = normalizeWhitespace(task.sourceText ?? renderByKind(task));
    const target = Math.min(
      task.targetLength ?? Math.floor(measureLength(base, task.countGraphemes) * 0.6),
      task.maxLength,
    );
    return truncateToLimit(base, Math.max(1, target), task.countGraphemes);
  }

  async expand(task: ContentGenerationTask): Promise<string> {
    const base = normalizeWhitespace(task.sourceText ?? renderByKind(task));
    const countGraphemes = task.countGraphemes;
    const currentLength = measureLength(base, countGraphemes);
    const target = Math.min(
      task.targetLength ?? currentLength + 40,
      task.maxLength,
    );

    let text = base;
    // 1) HONEST expansion: fold in richer detail the author actually supplied
    //    (the fuller description, the campaign name, the CTA) that isn't
    //    already present. Nothing here is invented — it all comes from the brief.
    for (const extra of expansionExtras(task)) {
      if (measureLength(text, countGraphemes) >= target) break;
      if (looseIncludes(text, extra)) continue;
      const candidate = normalizeWhitespace(`${text} ${extra}`);
      if (measureLength(candidate, countGraphemes) > task.maxLength) continue;
      text = candidate;
    }

    // 2) Last resort: if still short of the target and the brief had no more
    //    real detail, round the post out with generic (fact-free) invitations.
    for (const closer of EXPANSION_CLOSERS) {
      if (measureLength(text, countGraphemes) >= target) break;
      if (looseIncludes(text, closer)) continue;
      const candidate = normalizeWhitespace(`${text} ${closer}`);
      if (measureLength(candidate, countGraphemes) > task.maxLength) break;
      text = candidate;
    }

    return truncateToLimit(text, task.maxLength, countGraphemes);
  }
}

/** Real, brief-derived material `expand()` may fold in, in priority order. */
function expansionExtras(task: ContentGenerationTask): string[] {
  const { brief } = task;
  const extras: string[] = [];
  const description = normalizeWhitespace(brief.description);
  if (description) extras.push(asSentence(description));
  if (brief.cta) extras.push(asSentence(normalizeWhitespace(brief.cta)));
  if (brief.campaign) extras.push(`Part of ${normalizeWhitespace(brief.campaign)}.`);
  return extras;
}

/** Convenience: split a mock hashtag-kind result string back into candidate tokens. */
export function parseHashtagOutput(output: string): string[] {
  return splitCandidates(output);
}
