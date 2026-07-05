/**
 * Pure validation of a PostPayload against Discord's documented message/embed
 * limits. No network calls — used by both `validatePost` and (mandatorily,
 * per the contract) re-run inside `publish`/`edit` before any HTTP call.
 */

import type { PostPayload, ValidationIssue, ValidationResult } from '@social/core';
import {
  DISCORD_EMBED_AUTHOR_NAME_LIMIT,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  DISCORD_EMBED_FIELD_NAME_LIMIT,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
  DISCORD_EMBED_FOOTER_LIMIT,
  DISCORD_EMBED_MAX_FIELDS,
  DISCORD_EMBED_TITLE_LIMIT,
  DISCORD_EMBED_TOTAL_CHAR_BUDGET,
  DISCORD_MAX_EMBEDS,
  discordCapabilities,
} from './capabilities';
import type { DiscordEmbedInput, DiscordPlatformOptions } from './types';

function issue(
  code: string,
  message: string,
  severity: ValidationIssue['severity'],
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, message, severity, ...extra };
}

function readPlatformOptions(payload: PostPayload): DiscordPlatformOptions {
  return (payload.platformOptions as DiscordPlatformOptions | undefined) ?? {};
}

function validateEmbeds(embeds: DiscordEmbedInput[], fieldPrefix: string, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  if (embeds.length > DISCORD_MAX_EMBEDS) {
    errors.push(
      issue('too_many_embeds', `At most ${DISCORD_MAX_EMBEDS} embeds are allowed per message.`, 'error', {
        field: fieldPrefix,
        limit: DISCORD_MAX_EMBEDS,
        actual: embeds.length,
      }),
    );
  }

  let combined = 0;
  embeds.forEach((embed, i) => {
    const p = `${fieldPrefix}[${i}]`;
    if (embed.title) {
      combined += embed.title.length;
      if (embed.title.length > DISCORD_EMBED_TITLE_LIMIT) {
        errors.push(
          issue('embed_title_too_long', `Embed title exceeds ${DISCORD_EMBED_TITLE_LIMIT} characters.`, 'error', {
            field: `${p}.title`,
            limit: DISCORD_EMBED_TITLE_LIMIT,
            actual: embed.title.length,
          }),
        );
      }
    }
    if (embed.description) {
      combined += embed.description.length;
      if (embed.description.length > DISCORD_EMBED_DESCRIPTION_LIMIT) {
        errors.push(
          issue(
            'embed_description_too_long',
            `Embed description exceeds ${DISCORD_EMBED_DESCRIPTION_LIMIT} characters.`,
            'error',
            { field: `${p}.description`, limit: DISCORD_EMBED_DESCRIPTION_LIMIT, actual: embed.description.length },
          ),
        );
      }
    }
    if (embed.footer?.text) {
      combined += embed.footer.text.length;
      if (embed.footer.text.length > DISCORD_EMBED_FOOTER_LIMIT) {
        errors.push(
          issue('embed_footer_too_long', `Embed footer exceeds ${DISCORD_EMBED_FOOTER_LIMIT} characters.`, 'error', {
            field: `${p}.footer.text`,
            limit: DISCORD_EMBED_FOOTER_LIMIT,
            actual: embed.footer.text.length,
          }),
        );
      }
    }
    if (embed.author?.name) {
      combined += embed.author.name.length;
      if (embed.author.name.length > DISCORD_EMBED_AUTHOR_NAME_LIMIT) {
        errors.push(
          issue('embed_author_too_long', `Embed author name exceeds ${DISCORD_EMBED_AUTHOR_NAME_LIMIT} characters.`, 'error', {
            field: `${p}.author.name`,
            limit: DISCORD_EMBED_AUTHOR_NAME_LIMIT,
            actual: embed.author.name.length,
          }),
        );
      }
    }
    const fields = embed.fields ?? [];
    if (fields.length > DISCORD_EMBED_MAX_FIELDS) {
      errors.push(
        issue('too_many_embed_fields', `Embed has more than ${DISCORD_EMBED_MAX_FIELDS} fields.`, 'error', {
          field: `${p}.fields`,
          limit: DISCORD_EMBED_MAX_FIELDS,
          actual: fields.length,
        }),
      );
    }
    fields.forEach((field, j) => {
      combined += field.name.length + field.value.length;
      if (field.name.length > DISCORD_EMBED_FIELD_NAME_LIMIT) {
        errors.push(
          issue('embed_field_name_too_long', `Embed field name exceeds ${DISCORD_EMBED_FIELD_NAME_LIMIT} characters.`, 'error', {
            field: `${p}.fields[${j}].name`,
            limit: DISCORD_EMBED_FIELD_NAME_LIMIT,
            actual: field.name.length,
          }),
        );
      }
      if (field.value.length > DISCORD_EMBED_FIELD_VALUE_LIMIT) {
        errors.push(
          issue(
            'embed_field_value_too_long',
            `Embed field value exceeds ${DISCORD_EMBED_FIELD_VALUE_LIMIT} characters.`,
            'error',
            { field: `${p}.fields[${j}].value`, limit: DISCORD_EMBED_FIELD_VALUE_LIMIT, actual: field.value.length },
          ),
        );
      }
    });
  });

  if (combined > DISCORD_EMBED_TOTAL_CHAR_BUDGET) {
    errors.push(
      issue(
        'embed_total_too_long',
        `Combined embed text exceeds Discord's ${DISCORD_EMBED_TOTAL_CHAR_BUDGET}-character budget across all embeds on one message.`,
        'error',
        { field: fieldPrefix, limit: DISCORD_EMBED_TOTAL_CHAR_BUDGET, actual: combined },
      ),
    );
  }
  void warnings;
}

/** Validate a single (non-thread-recursed) payload; used by `validatePayloadTree` per node. */
function validateOne(payload: PostPayload, fieldPrefix: string): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const opts = readPlatformOptions(payload);

  const text = payload.text ?? '';
  if (text.length > discordCapabilities.characterLimit) {
    errors.push(
      issue('text_too_long', `Message content exceeds Discord's ${discordCapabilities.characterLimit}-character limit.`, 'error', {
        field: `${fieldPrefix}text`,
        limit: discordCapabilities.characterLimit,
        actual: text.length,
      }),
    );
  }

  const hasEmbeds = (opts.embeds?.length ?? 0) > 0;
  const hasMedia = (payload.media?.length ?? 0) > 0;
  if (!text && !hasEmbeds && !hasMedia) {
    errors.push(
      issue('empty_message', 'A Discord message needs at least one of: text, an embed, or media.', 'error', {
        field: fieldPrefix || 'text',
      }),
    );
  }

  if (payload.title && payload.title.length > (discordCapabilities.titleCharacterLimit ?? Infinity)) {
    warnings.push(
      issue(
        'title_ignored_or_truncated',
        'PostPayload.title is only used as a fallback embed title on Discord and exceeds the 256-character embed title limit; ' +
          'pass platformOptions.embeds explicitly to control embed content.',
        'warning',
        { field: `${fieldPrefix}title`, limit: discordCapabilities.titleCharacterLimit, actual: payload.title.length },
      ),
    );
  }

  if (opts.embeds && opts.embeds.length > 0) {
    validateEmbeds(opts.embeds, `${fieldPrefix}platformOptions.embeds`, errors, warnings);
  }

  const media = payload.media ?? [];
  if (media.length > discordCapabilities.maxMediaCount) {
    errors.push(
      issue('too_many_media', `At most ${discordCapabilities.maxMediaCount} attachments are allowed per message.`, 'error', {
        field: `${fieldPrefix}media`,
        limit: discordCapabilities.maxMediaCount,
        actual: media.length,
      }),
    );
  }
  media.forEach((m, i) => {
    const constraint = discordCapabilities.mediaConstraints.find(
      (c) => c.mimeTypes.includes(m.mimeType) || c.mimeTypes.includes('*/*'),
    );
    if (!constraint) {
      errors.push(
        issue('media_type_unsupported', `MIME type "${m.mimeType}" is not accepted by Discord attachments.`, 'error', {
          field: `${fieldPrefix}media[${i}].mimeType`,
        }),
      );
      return;
    }
    if (constraint.maxBytes !== undefined && m.bytes !== undefined && m.bytes > constraint.maxBytes) {
      errors.push(
        issue('media_too_large', `Attachment exceeds Discord's ${constraint.maxBytes}-byte base upload limit.`, 'error', {
          field: `${fieldPrefix}media[${i}].bytes`,
          limit: constraint.maxBytes,
          actual: m.bytes,
        }),
      );
    }
    if (m.altText && m.altText.length > (discordCapabilities.altTextCharacterLimit ?? Infinity)) {
      errors.push(
        issue(
          'alt_text_too_long',
          `Attachment description (alt text) exceeds ${discordCapabilities.altTextCharacterLimit} characters.`,
          'error',
          { field: `${fieldPrefix}media[${i}].altText`, limit: discordCapabilities.altTextCharacterLimit, actual: m.altText.length },
        ),
      );
    }
  });

  if (payload.quoteRemoteId) {
    errors.push(
      issue(
        'quote_not_supported',
        "Discord's bot API has no native 'quote post' feature; use replyToRemoteId (message reply) instead.",
        'error',
        { field: `${fieldPrefix}quoteRemoteId` },
      ),
    );
  }

  const mentionIds = [...(opts.roleMentionIds ?? []), ...(opts.userMentionIds ?? [])];
  for (const id of mentionIds) {
    if (!/^\d{17,20}$/.test(id)) {
      warnings.push(
        issue(
          'mention_id_not_snowflake',
          `"${id}" does not look like a Discord snowflake ID; role/user pings require the numeric ID, not a display name.`,
          'warning',
          { field: `${fieldPrefix}platformOptions` },
        ),
      );
    }
  }

  if (payload.tags && payload.tags.length > 0) {
    warnings.push(
      issue(
        'hashtags_cosmetic_only',
        'Discord has no hashtag feature; tags will be appended as plain "#tag" text with no special behavior.',
        'warning',
        { field: `${fieldPrefix}tags` },
      ),
    );
  }

  if (opts.channelId && opts.webhookUrl) {
    warnings.push(
      issue(
        'both_targets_set',
        'Both platformOptions.channelId and platformOptions.webhookUrl are set; webhookUrl takes precedence.',
        'warning',
        { field: `${fieldPrefix}platformOptions` },
      ),
    );
  }

  return { errors, warnings };
}

/** Validates the payload and, recursively, every entry in `thread[]`. */
export function validatePostPayload(payload: PostPayload): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const root = validateOne(payload, '');
  errors.push(...root.errors);
  warnings.push(...root.warnings);

  (payload.thread ?? []).forEach((child, i) => {
    const res = validateOne(child, `thread[${i}].`);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  });

  return { ok: errors.length === 0, errors, warnings };
}
