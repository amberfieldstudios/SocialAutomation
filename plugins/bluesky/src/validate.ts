/**
 * Pure `validatePost` logic for Bluesky — no network calls, no side effects
 * (per the contract). Shared by `BlueskyConnector.validatePost` and by
 * `publish`/`edit`, which must refuse anything this would reject.
 */

import type { CapabilityDescriptor, MediaSource, PostPayload, ValidationIssue, ValidationResult } from '@social/core';
import { assembleText, graphemeLength, utf8ByteLength } from './richtext';

function issue(
  code: string,
  message: string,
  severity: ValidationIssue['severity'],
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, message, severity, ...extra };
}

function validateMedia(media: MediaSource[] | undefined, caps: CapabilityDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!media || media.length === 0) return issues;

  if (media.length > caps.maxMediaCount) {
    issues.push(
      issue('too_many_media', `Post has ${media.length} media items; Bluesky allows at most ${caps.maxMediaCount}.`, 'error', {
        field: 'media',
        limit: caps.maxMediaCount,
        actual: media.length,
      }),
    );
  }

  const hasVideo = media.some((m) => m.mimeType.startsWith('video/'));
  const hasImage = media.some((m) => m.mimeType.startsWith('image/'));
  if (hasVideo && hasImage) {
    issues.push(
      issue('mixed_media_types', 'Bluesky posts embed either up to 4 images OR a single video, never both.', 'error', {
        field: 'media',
      }),
    );
  }
  if (hasVideo && media.length > 1) {
    issues.push(issue('too_many_videos', 'Bluesky posts support exactly one video embed.', 'error', { field: 'media' }));
  }

  media.forEach((m, i) => {
    const type: 'image' | 'video' | undefined = m.mimeType.startsWith('image/')
      ? 'image'
      : m.mimeType.startsWith('video/')
        ? 'video'
        : undefined;
    const field = `media[${i}]`;

    if (!type || !caps.supportedMediaTypes.includes(type)) {
      issues.push(issue('unsupported_media_type', `Media type for "${m.mimeType}" is not supported by Bluesky.`, 'error', { field }));
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
        issue('media_too_large', `Media at ${field} is ${m.bytes} bytes; Bluesky ${type} limit is ${constraint.maxBytes} bytes.`, 'error', {
          field,
          limit: constraint.maxBytes,
          actual: m.bytes,
        }),
      );
    }
    if (constraint.maxDurationMs !== undefined && m.durationMs !== undefined && m.durationMs > constraint.maxDurationMs) {
      issues.push(
        issue(
          'media_too_long',
          `Media at ${field} is ${m.durationMs}ms; Bluesky ${type} duration limit is ${constraint.maxDurationMs}ms.`,
          'error',
          { field, limit: constraint.maxDurationMs, actual: m.durationMs },
        ),
      );
    }
    if (caps.altTextCharacterLimit !== undefined && m.altText && graphemeLength(m.altText) > caps.altTextCharacterLimit) {
      issues.push(
        issue(
          'alt_text_too_long',
          `Alt text at ${field} is ${graphemeLength(m.altText)} graphemes; limit is ${caps.altTextCharacterLimit}.`,
          'error',
          { field: `${field}.altText`, limit: caps.altTextCharacterLimit, actual: graphemeLength(m.altText) },
        ),
      );
    }
  });

  return issues;
}

export function validateBlueskyPost(payload: PostPayload, caps: CapabilityDescriptor): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const text = assembleText(payload.text, payload.tags, payload.mentions);
  const graphemes = graphemeLength(text);
  const bytes = utf8ByteLength(text);

  if (graphemes > caps.characterLimit) {
    errors.push(
      issue('text_too_long', `Post text is ${graphemes} graphemes; Bluesky's limit is ${caps.characterLimit}.`, 'error', {
        field: 'text',
        limit: caps.characterLimit,
        actual: graphemes,
      }),
    );
  }
  const maxBytes = 3000; // app.bsky.feed.post maxLength
  if (bytes > maxBytes) {
    errors.push(
      issue('text_too_long_bytes', `Post text is ${bytes} UTF-8 bytes; Bluesky's byte limit is ${maxBytes}.`, 'error', {
        field: 'text',
        limit: maxBytes,
        actual: bytes,
      }),
    );
  }
  if (graphemes === 0 && (!payload.media || payload.media.length === 0)) {
    errors.push(issue('empty_post', 'A post must have text or media.', 'error', { field: 'text' }));
  }

  errors.push(...validateMedia(payload.media, caps));

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
      const childResult = validateBlueskyPost(child, caps);
      for (const e of childResult.errors) errors.push({ ...e, field: `thread[${i}].${e.field ?? ''}` });
      for (const w of childResult.warnings) warnings.push({ ...w, field: `thread[${i}].${w.field ?? ''}` });
    }
  }

  if (payload.title) {
    warnings.push(issue('title_ignored', 'Bluesky posts have no separate title field; it will be ignored.', 'warning', { field: 'title' }));
  }
  if (payload.scheduledAt) {
    warnings.push(
      issue('native_scheduling_unsupported', 'Bluesky has no native scheduling API; this must be scheduled by our own queue.', 'warning', {
        field: 'scheduledAt',
      }),
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
