/**
 * Pure `validatePost` logic for Mastodon — no network calls, no side effects
 * (per the contract). Shared by `MastodonConnector.validatePost` and by
 * `publish`/`edit`, which must refuse anything this would reject.
 */

import type { CapabilityDescriptor, MediaSource, PostPayload, ValidationIssue, ValidationResult } from '@social/core';

const URL_RE = /https?:\/\/[^\s]+/g;

function issue(
  code: string,
  message: string,
  severity: ValidationIssue['severity'],
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, message, severity, ...extra };
}

/**
 * Counts characters the way Mastodon's server-side counter does: every URL
 * substring is replaced by a fixed-length placeholder
 * (`countedUrlLength`/`characters_reserved_per_url`, documented default 23),
 * regardless of the URL's real length.
 */
export function countedLength(text: string, countedUrlLength: number | undefined): number {
  if (countedUrlLength === undefined) return [...text].length;
  let remaining = text;
  let total = 0;
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    total += [...before].length;
    total += countedUrlLength;
    lastIndex = match.index + match[0].length;
  }
  remaining = text.slice(lastIndex);
  total += [...remaining].length;
  return total;
}

function validateMedia(media: MediaSource[] | undefined, caps: CapabilityDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!media || media.length === 0) return issues;

  if (media.length > caps.maxMediaCount) {
    issues.push(
      issue(
        'too_many_media',
        `Post has ${media.length} media items; Mastodon allows at most ${caps.maxMediaCount} per status.`,
        'error',
        { field: 'media', limit: caps.maxMediaCount, actual: media.length },
      ),
    );
  }

  const classify = (m: MediaSource): 'image' | 'video' | 'gif' | 'audio' | undefined => {
    if (m.mimeType === 'image/gif') return 'gif';
    if (m.mimeType.startsWith('image/')) return 'image';
    if (m.mimeType.startsWith('video/')) return 'video';
    if (m.mimeType.startsWith('audio/')) return 'audio';
    return undefined;
  };

  const hasVideoOrAudio = media.some((m) => classify(m) === 'video' || classify(m) === 'audio');
  if (hasVideoOrAudio && media.length > 1) {
    issues.push(
      issue('too_many_videos', 'A Mastodon status may attach exactly one video/audio item, never combined with other media.', 'error', {
        field: 'media',
      }),
    );
  }

  media.forEach((m, i) => {
    const type = classify(m);
    const field = `media[${i}]`;

    if (!type || !caps.supportedMediaTypes.includes(type)) {
      issues.push(issue('unsupported_media_type', `Media type for "${m.mimeType}" is not supported by Mastodon.`, 'error', { field }));
      return;
    }
    const constraint = caps.mediaConstraints.find((c) => c.type === type);
    if (!constraint) return;

    if (!constraint.mimeTypes.includes(m.mimeType)) {
      issues.push(
        issue('unsupported_mime_type', `MIME type "${m.mimeType}" is not one of: ${constraint.mimeTypes.join(', ')}.`, 'error', {
          field,
        }),
      );
    }
    if (constraint.maxBytes !== undefined && m.bytes !== undefined && m.bytes > constraint.maxBytes) {
      issues.push(
        issue('media_too_large', `Media at ${field} is ${m.bytes} bytes; Mastodon's ${type} limit is ${constraint.maxBytes} bytes.`, 'error', {
          field,
          limit: constraint.maxBytes,
          actual: m.bytes,
        }),
      );
    }
    if (caps.altTextCharacterLimit !== undefined && m.altText && m.altText.length > caps.altTextCharacterLimit) {
      issues.push(
        issue(
          'alt_text_too_long',
          `Alt text at ${field} is ${m.altText.length} characters; limit is ${caps.altTextCharacterLimit}.`,
          'error',
          { field: `${field}.altText`, limit: caps.altTextCharacterLimit, actual: m.altText.length },
        ),
      );
    }
  });

  return issues;
}

const VALID_VISIBILITIES = new Set(['public', 'unlisted', 'private', 'direct']);

export function validateMastodonPost(payload: PostPayload, caps: CapabilityDescriptor, now: () => Date = () => new Date()): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const text = payload.text ?? '';
  const length = countedLength(text, caps.countedUrlLength);

  if (length > caps.characterLimit) {
    errors.push(
      issue('text_too_long', `Post text is ${length} counted characters; Mastodon's default limit is ${caps.characterLimit}.`, 'error', {
        field: 'text',
        limit: caps.characterLimit,
        actual: length,
      }),
    );
  }
  if (length === 0 && (!payload.media || payload.media.length === 0)) {
    errors.push(issue('empty_post', 'A status must have text or media.', 'error', { field: 'text' }));
  }

  errors.push(...validateMedia(payload.media, caps));

  const visibility = (payload.platformOptions?.visibility as string | undefined) ?? 'public';
  if (!VALID_VISIBILITIES.has(visibility)) {
    errors.push(
      issue(
        'invalid_visibility',
        `platformOptions.visibility "${visibility}" is not one of: ${[...VALID_VISIBILITIES].join(', ')}.`,
        'error',
        { field: 'platformOptions.visibility' },
      ),
    );
  }

  const spoilerText = payload.platformOptions?.spoilerText as string | undefined;
  if (spoilerText !== undefined && spoilerText.length > caps.characterLimit) {
    errors.push(
      issue('spoiler_text_too_long', `Content-warning text is ${spoilerText.length} characters; limit is ${caps.characterLimit}.`, 'error', {
        field: 'platformOptions.spoilerText',
      }),
    );
  }

  if (payload.thread && payload.thread.length > 0) {
    if (caps.maxThreadLength !== undefined && payload.thread.length + 1 > caps.maxThreadLength) {
      errors.push(
        issue(
          'thread_too_long',
          `Thread has ${payload.thread.length + 1} posts; the connector caps threads at ${caps.maxThreadLength}.`,
          'error',
          { field: 'thread', limit: caps.maxThreadLength, actual: payload.thread.length + 1 },
        ),
      );
    }
    for (let i = 0; i < payload.thread.length; i += 1) {
      const child = payload.thread[i];
      if (!child) continue;
      const childResult = validateMastodonPost(child, caps, now);
      for (const e of childResult.errors) errors.push({ ...e, field: `thread[${i}].${e.field ?? ''}` });
      for (const w of childResult.warnings) warnings.push({ ...w, field: `thread[${i}].${w.field ?? ''}` });
    }
  }

  if (payload.title) {
    warnings.push(issue('title_ignored', 'Mastodon statuses have no separate title field; it will be ignored.', 'warning', { field: 'title' }));
  }

  if (payload.scheduledAt) {
    const scheduledMs = Date.parse(payload.scheduledAt);
    const minLeadMs = 5 * 60 * 1000; // documented minimum lead time for scheduled_at
    if (Number.isNaN(scheduledMs)) {
      errors.push(issue('invalid_scheduled_at', `scheduledAt "${payload.scheduledAt}" is not a valid ISO-8601 timestamp.`, 'error', { field: 'scheduledAt' }));
    } else if (scheduledMs - now().getTime() < minLeadMs) {
      errors.push(
        issue('scheduled_at_too_soon', 'Mastodon requires scheduled_at to be at least 5 minutes in the future.', 'error', {
          field: 'scheduledAt',
        }),
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
