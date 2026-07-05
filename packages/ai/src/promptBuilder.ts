/**
 * Shared prompt construction for every real `ContentProvider` (Claude,
 * OpenAI, ...). Extracted out of `claudeProvider.ts` so a second provider
 * never forks this logic — both providers must produce byte-identical
 * prompts for the same `ContentGenerationTask`/op pair, or the two providers'
 * output stops being comparable for A/B or fallback purposes.
 *
 * `SYSTEM_PROMPT` is likewise shared: it is provider-agnostic instruction
 * text (no vendor-specific phrasing), sent as the `system` message on the
 * Anthropic Messages API and as a `role: 'system'` message on OpenAI's Chat
 * Completions API.
 */

import type { ContentGenerationTask } from './types';

export const SYSTEM_PROMPT =
  'You write concise, platform-native social media copy from a content brief. ' +
  'Respond with ONLY the requested text — no preamble, no quotation marks, no markdown formatting, ' +
  'no explanation of what you did. If asked for a list of hashtags, respond with the hashtags only, ' +
  'space-separated, without the leading "#".';

export type ContentOp = 'generate' | 'rewrite' | 'shorten' | 'expand';

export function buildPrompt(task: ContentGenerationTask, op: ContentOp): string {
  const lines: string[] = [task.toneInstruction, ''];
  lines.push(`Content brief: ${task.brief.description}`);
  if (task.brief.campaign) lines.push(`Campaign: ${task.brief.campaign}`);
  if (task.brief.link) lines.push(`Link to reference (do not invent a different one): ${task.brief.link}`);
  if (task.brief.cta) lines.push(`Desired call to action: ${task.brief.cta}`);
  if (task.seoKeywords && task.seoKeywords.length > 0) {
    lines.push(`Favor these search keywords where natural: ${task.seoKeywords.join(', ')}`);
  }
  lines.push('');

  switch (task.kind) {
    case 'hashtags':
      lines.push(
        `Generate up to ${task.maxHashtags ?? 5} relevant hashtags for this post, without the leading '#'.`,
      );
      break;
    case 'title':
      lines.push(`Write a title/headline, at most ${task.maxLength} characters.`);
      break;
    case 'cta':
      lines.push(`Write a short call-to-action phrase, at most ${task.maxLength} characters.`);
      break;
    case 'emoji':
      lines.push(
        `Add tasteful, platform-appropriate emoji to the following text without changing its meaning:\n${task.sourceText ?? ''}`,
      );
      break;
    case 'body':
    default:
      switch (op) {
        case 'rewrite':
          lines.push(`Rewrite the following text in a different phrasing but the same meaning:\n${task.sourceText ?? ''}`);
          break;
        case 'shorten':
          lines.push(
            `Shorten the following text to at most ${task.targetLength ?? task.maxLength} characters, preserving the key point:\n${task.sourceText ?? ''}`,
          );
          break;
        case 'expand':
          lines.push(
            `Expand the following text to about ${task.targetLength ?? task.maxLength} characters, adding relevant detail without changing its meaning:\n${task.sourceText ?? ''}`,
          );
          break;
        case 'generate':
        default:
          lines.push(`Write the post body.`);
      }
  }
  lines.push('', `Hard limit: at most ${task.maxLength} ${task.countGraphemes ? 'characters (Unicode graphemes)' : 'characters'}.`);
  return lines.join('\n');
}
