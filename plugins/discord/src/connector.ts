/**
 * DiscordConnector — implements PlatformConnector using ONLY Discord's official
 * REST bot API (`https://discord.com/api/v10`) and the webhook execute API.
 * No scraping, no gateway/websocket automation, no undocumented endpoints.
 *
 * Credential flow (see README.md "Credential flow" for the full explanation):
 *  - `OperationContext.token.tokenType` selects how we authenticate:
 *      'bot'     -> `Authorization: Bot <accessToken>`     (bot API)
 *      'webhook' -> `accessToken` IS the full webhook URL  (webhook API)
 *      anything else (e.g. 'Bearer')  -> OAuth2 user/app token (`Authorization: Bearer <accessToken>`)
 *  - The token itself is supplied by `@social/auth`'s TokenManager via
 *    `OperationContext`; this connector never reads a vault/DB directly.
 */

import {
  AuthError,
  ConnectorError,
  NotSupportedError,
  ValidationFailedError,
  assertSupported,
  type AnalyticsQuery,
  type AnalyticsSnapshot,
  type AuthRequest,
  type AuthResult,
  type CapabilityDescriptor,
  type ConnectInput,
  type ConnectResult,
  type ConnectorRuntime,
  type DeleteRequest,
  type DeleteResult,
  type DisconnectResult,
  type EditRequest,
  type EditResult,
  type MediaSource,
  type OperationContext,
  type PlatformConnector,
  type PlatformProfile,
  type PostPayload,
  type PublishResult,
  type RefreshInput,
  type TargetContext,
  type TokenSet,
  type UploadedMedia,
  type ValidationResult,
} from '@social/core';

import { discordCapabilities, discordCapabilitiesFor } from './capabilities';
import { DiscordHttpClient, type DiscordCredential, type DiscordRequestFile } from './http';
import { readMediaBytes } from './media';
import type { DiscordActionRow, DiscordEmbedInput, DiscordPlatformOptions } from './types';
import { validatePostPayload } from './validation';

interface DiscordOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface DiscordMessageResponse {
  id: string;
  channel_id: string;
  timestamp: string;
}

/**
 * Contract v1.1: Discord has no single-id addressable message without a
 * channel/webhook, so `publish()` returns a typed `PublishResult.target`
 * (`TargetContext`) alongside the bare message id in `remoteId` — callers
 * persist both and pass `target` back on `delete`/`edit`/`getAnalytics`. This
 * replaces the old per-connector composite-string `remoteId` convention
 * (`"channel:<id>:<messageId>"` / `"webhook:<id>:<messageId>"`).
 *
 * SECURITY: the webhook's secret token is deliberately NEVER placed in
 * `target` either. `PublishResult`/`target` are persisted at rest in
 * plaintext (e.g. `post_variants.remote_id`/`target`, plain columns — not the
 * encrypted token vault), so they must never carry a live credential. Only
 * the non-secret webhook id is encoded (`target.extra.webhookId`).
 * `delete()`/`edit()` source the webhook token from `OperationContext.token`
 * (via `credentialFromToken`), which is supplied fresh on every call by the
 * vault.
 */
type MessageTarget =
  | { kind: 'channel'; channelId: string }
  | { kind: 'webhook'; webhookId: string };

function buildTarget(target: MessageTarget): TargetContext {
  if (target.kind === 'channel') {
    return { channelId: target.channelId, extra: { kind: 'channel' } };
  }
  return { extra: { kind: 'webhook', webhookId: target.webhookId } };
}

/**
 * Resolves a `MessageTarget` from a `TargetContext`. Falls back to parsing the
 * pre-v1.1 composite `remoteId` convention (`"channel:<id>:<msgId>"` /
 * `"webhook:<id>:<msgId>"`) so already-persisted rows from before this change
 * keep working; new calls should always supply `target`.
 */
function resolveTarget(remoteId: string, target: TargetContext | undefined): { messageId: string; target: MessageTarget } {
  if (target?.channelId) {
    return { messageId: remoteId, target: { kind: 'channel', channelId: target.channelId } };
  }
  if (target?.extra?.kind === 'webhook' && target.extra.webhookId) {
    return { messageId: remoteId, target: { kind: 'webhook', webhookId: target.extra.webhookId } };
  }

  // Legacy fallback: pre-v1.1 composite remoteId.
  const parts = remoteId.split(':');
  if ((parts[0] === 'webhook' || parts[0] === 'channel') && parts.length === 3) {
    return parts[0] === 'channel'
      ? { messageId: parts[2]!, target: { kind: 'channel', channelId: parts[1]! } }
      : { messageId: parts[2]!, target: { kind: 'webhook', webhookId: parts[1]! } };
  }

  throw new ConnectorError(
    'validation_failed',
    `Cannot address a Discord message from remoteId "${remoteId}" without a target: pass the ` +
      `"target" (TargetContext) returned in PublishResult.target — { channelId } for a bot-API ` +
      `message or { extra: { kind: 'webhook', webhookId } } for a webhook-API message.`,
    { platform: 'discord' },
  );
}

/** `remoteId` is a bare message id (Contract v1.1+); tolerates the legacy composite form too. */
function bareMessageId(remoteId: string): string {
  const parts = remoteId.split(':');
  if ((parts[0] === 'webhook' || parts[0] === 'channel') && parts.length === 3) return parts[2]!;
  return remoteId;
}

function credentialFromToken(token: TokenSet): DiscordCredential {
  const type = (token.tokenType ?? '').toLowerCase();
  if (type === 'bot') return { kind: 'bot', value: token.accessToken };
  if (type === 'webhook') return { kind: 'webhook', value: token.accessToken };
  return { kind: 'oauth', value: token.accessToken };
}

function opts(payload: PostPayload): DiscordPlatformOptions {
  return (payload.platformOptions as DiscordPlatformOptions | undefined) ?? {};
}

function mapEmbed(e: DiscordEmbedInput): Record<string, unknown> {
  return {
    ...(e.title !== undefined ? { title: e.title } : {}),
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.url !== undefined ? { url: e.url } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
    ...(e.timestamp !== undefined ? { timestamp: e.timestamp } : {}),
    ...(e.footer ? { footer: { text: e.footer.text, ...(e.footer.iconUrl ? { icon_url: e.footer.iconUrl } : {}) } } : {}),
    ...(e.image ? { image: { url: e.image.url } } : {}),
    ...(e.thumbnail ? { thumbnail: { url: e.thumbnail.url } } : {}),
    ...(e.author
      ? {
          author: {
            name: e.author.name,
            ...(e.author.url ? { url: e.author.url } : {}),
            ...(e.author.iconUrl ? { icon_url: e.author.iconUrl } : {}),
          },
        }
      : {}),
    ...(e.fields ? { fields: e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false })) } : {}),
  };
}

function mapComponents(rows: DiscordActionRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    type: 1,
    components: row.components.map((c) => ({
      type: 2,
      style: c.style,
      ...(c.label !== undefined ? { label: c.label } : {}),
      ...(c.customId !== undefined ? { custom_id: c.customId } : {}),
      ...(c.url !== undefined ? { url: c.url } : {}),
      ...(c.disabled !== undefined ? { disabled: c.disabled } : {}),
      ...(c.emoji ? { emoji: c.emoji } : {}),
    })),
  }));
}

function buildContentWithMentions(text: string | undefined, options: DiscordPlatformOptions): string {
  const prefixes: string[] = [];
  const base = text ?? '';
  for (const roleId of options.roleMentionIds ?? []) {
    if (!base.includes(`<@&${roleId}>`)) prefixes.push(`<@&${roleId}>`);
  }
  for (const userId of options.userMentionIds ?? []) {
    if (!base.includes(`<@${userId}>`)) prefixes.push(`<@${userId}>`);
  }
  if (prefixes.length === 0) return base;
  return base ? `${prefixes.join(' ')} ${base}` : prefixes.join(' ');
}

interface BuiltMessage {
  body: Record<string, unknown>;
  files: DiscordRequestFile[];
}

async function buildMessageBody(payload: PostPayload): Promise<BuiltMessage> {
  const options = opts(payload);
  const content = buildContentWithMentions(payload.text, options);

  const embeds: DiscordEmbedInput[] = options.embeds ? [...options.embeds] : [];
  if (embeds.length === 0 && payload.title) {
    embeds.push({ title: payload.title });
  }
  if (payload.tags && payload.tags.length > 0) {
    // Discord has no hashtag feature; append as literal (cosmetic) text — see validation.ts warning.
  }

  const files: DiscordRequestFile[] = [];
  const attachments: Record<string, unknown>[] = [];
  const media = payload.media ?? [];
  for (let i = 0; i < media.length; i++) {
    const source = media[i] as MediaSource;
    const file = await readMediaBytes(source, i);
    files.push(file);
    attachments.push({ id: String(i), filename: file.filename, ...(source.altText ? { description: source.altText } : {}) });
  }

  const allowedMentions = {
    parse: options.everyoneMention ? ['everyone'] : [],
    roles: options.roleMentionIds ?? [],
    users: options.userMentionIds ?? [],
  };

  const body: Record<string, unknown> = {
    ...(content ? { content } : {}),
    ...(embeds.length > 0 ? { embeds: embeds.map(mapEmbed) } : {}),
    allowed_mentions: allowedMentions,
    ...(payload.replyToRemoteId ? { message_reference: { message_id: bareMessageId(payload.replyToRemoteId) } } : {}),
    ...(options.components ? { components: mapComponents(options.components) } : {}),
    ...(options.tts ? { tts: true } : {}),
    ...(options.suppressEmbeds ? { flags: 1 << 2 } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(options.webhookUsername ? { username: options.webhookUsername } : {}),
    ...(options.webhookAvatarUrl ? { avatar_url: options.webhookAvatarUrl } : {}),
  };

  return { body, files };
}

export class DiscordConnector implements PlatformConnector {
  readonly capabilities = discordCapabilities;
  private readonly http = new DiscordHttpClient();
  private readonly logger;
  private readonly now: () => Date;

  constructor(runtime: ConnectorRuntime) {
    this.logger = runtime.logger.child({ platform: 'discord' });
    this.now = runtime.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------
  // connect
  // ---------------------------------------------------------------------
  async connect(input: ConnectInput): Promise<ConnectResult> {
    const log = this.logger.child({ operation: 'connect' });
    if (input.token) {
      const credential = credentialFromToken(input.token);
      if (credential.kind === 'webhook') {
        await this.http.request({ method: 'GET', webhookUrl: credential.value, logger: log, operation: 'connect' });
      } else if (credential.kind === 'bot') {
        await this.http.request({ method: 'GET', path: '/users/@me', credential, logger: log, operation: 'connect' });
      } else {
        await this.http.request({ method: 'GET', path: '/oauth2/@me', credential, logger: log, operation: 'connect' });
      }
    } else {
      // No account-bound credential yet: verify basic reachability via the public, unauthenticated /gateway endpoint.
      await this.http.request({ method: 'GET', path: '/gateway', logger: log, operation: 'connect' });
    }
    log.info('discord.connected', { hasToken: Boolean(input.token) });
    return { ready: true, platform: 'discord', apiVersion: 'v10' };
  }

  // ---------------------------------------------------------------------
  // authenticate
  // ---------------------------------------------------------------------
  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const log = this.logger.child({ operation: 'authenticate' });

    if (request.kind === 'authorize_url') {
      const params = new URLSearchParams({
        client_id: request.app.clientId,
        response_type: 'code',
        scope: request.scopes.join(' '),
        state: request.state,
      });
      if (request.app.redirectUri) params.set('redirect_uri', request.app.redirectUri);
      if (request.codeChallenge) {
        params.set('code_challenge', request.codeChallenge);
        params.set('code_challenge_method', 'S256');
      }
      if (request.app.extra?.permissions) params.set('permissions', request.app.extra.permissions);
      if (request.app.extra?.guildId) params.set('guild_id', request.app.extra.guildId);
      return { authorizeUrl: `https://discord.com/oauth2/authorize?${params.toString()}` };
    }

    if (request.kind === 'exchange_code') {
      const form: Record<string, string> = {
        grant_type: 'authorization_code',
        code: request.code,
        client_id: request.app.clientId,
      };
      if (request.app.clientSecret) form.client_secret = request.app.clientSecret;
      if (request.app.redirectUri) form.redirect_uri = request.app.redirectUri;
      if (request.codeVerifier) form.code_verifier = request.codeVerifier;

      const tokenRes = await this.http.request<DiscordOAuthTokenResponse>({
        method: 'POST',
        path: '/oauth2/token',
        form,
        logger: log,
        operation: 'authenticate.exchange_code',
      });
      const token = this.toTokenSet(tokenRes);

      let profile: PlatformProfile | undefined;
      try {
        const me = await this.http.request<{ id: string; username: string; avatar?: string }>({
          method: 'GET',
          path: '/users/@me',
          credential: { kind: 'oauth', value: token.accessToken },
          logger: log,
          operation: 'authenticate.profile',
        });
        profile = {
          remoteId: me.id,
          handle: me.username,
          avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : undefined,
          raw: me,
        };
      } catch (error) {
        log.warn('discord.profile_fetch_failed', { errorCode: error instanceof ConnectorError ? error.code : 'unknown' });
      }

      log.info('discord.authenticated', { kind: 'exchange_code', scopes: token.scopes });
      return { token, profile };
    }

    if (request.kind === 'password') {
      // Discord has no password-grant flow; it is pure OAuth2.
      throw new AuthError('Discord does not support password-grant authentication.', {
        platform: 'discord',
        operation: 'authenticate',
      });
    }

    // client_credentials
    const basic = Buffer.from(`${request.app.clientId}:${request.app.clientSecret ?? ''}`).toString('base64');
    const tokenRes = await this.http.request<DiscordOAuthTokenResponse>({
      method: 'POST',
      path: '/oauth2/token',
      form: { grant_type: 'client_credentials', scope: request.scopes.join(' ') },
      headers: { Authorization: `Basic ${basic}` },
      logger: log,
      operation: 'authenticate.client_credentials',
    });
    const token = this.toTokenSet(tokenRes);
    log.info('discord.authenticated', { kind: 'client_credentials', scopes: token.scopes });
    return { token };
  }

  // ---------------------------------------------------------------------
  // capabilitiesFor — Contract v1.1 per-credential-shape capability
  // ---------------------------------------------------------------------
  capabilitiesFor(token: TokenSet): CapabilityDescriptor {
    return discordCapabilitiesFor(token);
  }

  // ---------------------------------------------------------------------
  // refreshToken
  // ---------------------------------------------------------------------
  async refreshToken(input: RefreshInput): Promise<TokenSet> {
    const log = this.logger.child({ operation: 'refreshToken' });
    // Bot tokens and webhook URLs are long-lived static secrets issued in the
    // developer portal; Discord's API has no refresh grant for them. Contract
    // v1.1's `capabilitiesFor` narrows `operations.refreshToken` to `false`
    // for that credential shape, so `assertSupported` throws the paired
    // `NotSupportedError` here instead of the plain `AuthError` this connector
    // used before per-credential capabilities existed.
    assertSupported(discordCapabilitiesFor(input.token), 'refreshToken');
    if (!input.token.refreshToken) {
      log.warn('discord.refresh_missing_token', { tokenType: input.token.tokenType ?? 'unknown' });
      throw new AuthError('This OAuth2 credential has no refresh token to exchange.', {
        platform: 'discord',
        operation: 'refreshToken',
      });
    }

    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: input.token.refreshToken,
      client_id: input.app.clientId,
    };
    if (input.app.clientSecret) form.client_secret = input.app.clientSecret;

    const tokenRes = await this.http.request<DiscordOAuthTokenResponse>({
      method: 'POST',
      path: '/oauth2/token',
      form,
      logger: log,
      operation: 'refreshToken',
    });
    const fresh = this.toTokenSet(tokenRes);
    log.info('discord.token_refreshed', { scopes: fresh.scopes, expiresAt: fresh.expiresAt });
    return fresh;
  }

  // ---------------------------------------------------------------------
  // validatePost
  // ---------------------------------------------------------------------
  async validatePost(payload: PostPayload): Promise<ValidationResult> {
    return Promise.resolve(validatePostPayload(payload));
  }

  // ---------------------------------------------------------------------
  // uploadMedia
  // ---------------------------------------------------------------------
  async uploadMedia(media: MediaSource, ctx: OperationContext): Promise<UploadedMedia> {
    const log = ctx.logger.child({ operation: 'uploadMedia' });
    const constraint = discordCapabilities.mediaConstraints.find(
      (c) => c.mimeTypes.includes(media.mimeType) || c.mimeTypes.includes('*/*'),
    );
    if (!constraint) {
      throw new ConnectorError('media_rejected', `MIME type "${media.mimeType}" is not accepted by Discord attachments.`, {
        platform: 'discord',
        operation: 'uploadMedia',
      });
    }
    if (constraint.maxBytes !== undefined && media.bytes !== undefined && media.bytes > constraint.maxBytes) {
      throw new ConnectorError('media_rejected', `Attachment exceeds Discord's ${constraint.maxBytes}-byte upload limit.`, {
        platform: 'discord',
        operation: 'uploadMedia',
      });
    }
    // Contract v1.1 `mediaUploadMode: 'inline'` (declared in capabilities.ts):
    // Discord's bot/webhook message APIs do not support staging a file
    // independent of a message-send call, so no bytes are transferred here.
    // `publish`/`edit` read `source.uri` again and attach the bytes inline as
    // multipart. `remoteMediaId` is a LOCAL pending handle only — never a
    // Discord-issued id, per the documented 'inline' convention.
    log.info('discord.media_staged', { assetId: media.assetId, mimeType: media.mimeType, bytes: media.bytes });
    return { source: media, remoteMediaId: `pending:${media.assetId}`, raw: { staged: 'local-only' } };
  }

  // ---------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------
  async publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult> {
    const log = ctx.logger.child({ operation: 'publish' });

    const validation = validatePostPayload(payload);
    if (!validation.ok) {
      throw new ValidationFailedError(validation, { platform: 'discord', operation: 'publish' });
    }

    const first = await this.sendOne(payload, ctx, log);
    const threadRemoteIds = [first.remoteId];

    let previous = first;
    for (const child of payload.thread ?? []) {
      const chained: PostPayload = {
        ...child,
        platform: child.platform ?? payload.platform,
        accountId: child.accountId ?? payload.accountId,
        replyToRemoteId: child.replyToRemoteId ?? previous.remoteId,
        platformOptions: { ...opts(payload), ...opts(child) },
      };
      const childValidation = validatePostPayload(chained);
      if (!childValidation.ok) {
        throw new ValidationFailedError(childValidation, { platform: 'discord', operation: 'publish' });
      }
      previous = await this.sendOne(chained, ctx, log);
      threadRemoteIds.push(previous.remoteId);
    }

    log.info('discord.published', { remoteId: first.remoteId, threadLength: threadRemoteIds.length });
    return { ...first, threadRemoteIds };
  }

  private async sendOne(payload: PostPayload, ctx: OperationContext, log: OperationContext['logger']): Promise<PublishResult> {
    const options = opts(payload);
    const credential = credentialFromToken(ctx.token);
    const { body, files } = await buildMessageBody(payload);

    if (credential.kind === 'webhook' || (options.webhookUrl && credential.kind !== 'bot')) {
      const webhookUrl = options.webhookUrl ?? credential.value;
      const query = options.threadId ? `?wait=true&thread_id=${encodeURIComponent(options.threadId)}` : '?wait=true';
      if (options.createThread) {
        log.warn('discord.create_thread_unsupported_for_webhook', {
          reason: 'Starting a NEW thread from a webhook message is not supported by this connector; use a bot credential.',
        });
      }
      const message = await this.http.request<DiscordMessageResponse>({
        method: 'POST',
        webhookUrl,
        query,
        body,
        files,
        logger: log,
        operation: 'publish.webhook',
      });
      const parts = webhookUrl.split('/');
      const webhookId = parts[parts.length - 2] ?? 'unknown';
      return {
        remoteId: message.id,
        target: buildTarget({ kind: 'webhook', webhookId }),
        publishedAt: message.timestamp ?? this.now().toISOString(),
        raw: message,
      };
    }

    const channelId = options.threadId ?? options.channelId;
    if (!channelId) {
      throw new ValidationFailedError(
        {
          ok: false,
          errors: [
            {
              code: 'missing_target',
              message:
                'platformOptions.channelId (or threadId) is required to publish via the Discord bot API; ' +
                'platformOptions.webhookUrl is required for webhook-credentialed accounts.',
              severity: 'error',
              field: 'platformOptions.channelId',
            },
          ],
          warnings: [],
        },
        { platform: 'discord', operation: 'publish' },
      );
    }

    const message = await this.http.request<DiscordMessageResponse>({
      method: 'POST',
      path: `/channels/${channelId}/messages`,
      body,
      files,
      credential,
      logger: log,
      operation: 'publish.bot',
    });

    if (options.createThread) {
      await this.http.request({
        method: 'POST',
        path: `/channels/${channelId}/messages/${message.id}/threads`,
        body: {
          name: options.createThread.name,
          ...(options.createThread.autoArchiveMinutes ? { auto_archive_duration: options.createThread.autoArchiveMinutes } : {}),
        },
        credential,
        logger: log,
        operation: 'publish.create_thread',
      });
    }

    const guildId = options.guildId;
    return {
      remoteId: message.id,
      target: buildTarget({ kind: 'channel', channelId }),
      remoteUrl: `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${message.id}`,
      publishedAt: message.timestamp ?? this.now().toISOString(),
      raw: message,
    };
  }

  // ---------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------
  async delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult> {
    assertSupported(this.capabilities, 'delete');
    const log = ctx.logger.child({ operation: 'delete' });
    const { messageId, target } = resolveTarget(request.remoteId, request.target);
    const credential = credentialFromToken(ctx.token);

    if (target.kind === 'webhook') {
      if (credential.kind !== 'webhook') {
        throw new AuthError(
          'Deleting a webhook-published message requires a webhook credential (the webhook URL, including its secret ' +
            'token) on OperationContext.token; the token is never read back out of the target/remoteId.',
          { platform: 'discord', operation: 'delete' },
        );
      }
      await this.http.request({
        method: 'DELETE',
        webhookUrl: `${credential.value}/messages/${messageId}`,
        logger: log,
        operation: 'delete.webhook',
      });
    } else {
      await this.http.request({
        method: 'DELETE',
        path: `/channels/${target.channelId}/messages/${messageId}`,
        credential,
        logger: log,
        operation: 'delete.bot',
      });
    }
    log.info('discord.deleted', { remoteId: request.remoteId });
    return { removed: true };
  }

  // ---------------------------------------------------------------------
  // edit
  // ---------------------------------------------------------------------
  async edit(request: EditRequest, ctx: OperationContext): Promise<EditResult> {
    assertSupported(this.capabilities, 'edit');
    const log = ctx.logger.child({ operation: 'edit' });

    const validation = validatePostPayload(request.payload);
    if (!validation.ok) {
      throw new ValidationFailedError(validation, { platform: 'discord', operation: 'edit' });
    }

    const { messageId, target } = resolveTarget(request.remoteId, request.target);
    const credential = credentialFromToken(ctx.token);
    const { body, files } = await buildMessageBody(request.payload);

    let message: DiscordMessageResponse;
    if (target.kind === 'webhook') {
      if (credential.kind !== 'webhook') {
        throw new AuthError(
          'Editing a webhook-published message requires a webhook credential (the webhook URL, including its secret ' +
            'token) on OperationContext.token; the token is never read back out of the target/remoteId.',
          { platform: 'discord', operation: 'edit' },
        );
      }
      message = await this.http.request<DiscordMessageResponse>({
        method: 'PATCH',
        webhookUrl: `${credential.value}/messages/${messageId}`,
        body,
        files,
        logger: log,
        operation: 'edit.webhook',
      });
    } else {
      message = await this.http.request<DiscordMessageResponse>({
        method: 'PATCH',
        path: `/channels/${target.channelId}/messages/${messageId}`,
        body,
        files,
        credential,
        logger: log,
        operation: 'edit.bot',
      });
    }

    log.info('discord.edited', { remoteId: request.remoteId });
    return {
      remoteId: request.remoteId,
      editedAt: message.timestamp ?? this.now().toISOString(),
      raw: message,
    };
  }

  // ---------------------------------------------------------------------
  // getAnalytics — NOT SUPPORTED (see capabilities.ts + README "Contract gaps" #3)
  // ---------------------------------------------------------------------
  async getAnalytics(_query: AnalyticsQuery, _ctx: OperationContext): Promise<AnalyticsSnapshot> {
    assertSupported(this.capabilities, 'getAnalytics');
    // Unreachable: assertSupported always throws because operations.getAnalytics === false.
    throw new NotSupportedError('getAnalytics', 'discord');
  }

  // ---------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------
  async disconnect(ctx: OperationContext): Promise<DisconnectResult> {
    const log = ctx.logger.child({ operation: 'disconnect' });
    // Bot tokens/webhook URLs cannot be revoked via any documented API call —
    // only regenerated in the developer portal. Contract v1.1's
    // `capabilitiesFor` declares `disconnect: false` for that credential
    // shape, so this throws the paired `NotSupportedError` here rather than
    // returning a soft `{ revoked: false }`.
    assertSupported(discordCapabilitiesFor(ctx.token), 'disconnect');
    const credential = credentialFromToken(ctx.token);

    if (credential.kind === 'oauth' && ctx.token.refreshToken) {
      try {
        await this.http.request({
          method: 'POST',
          path: '/oauth2/token/revoke',
          form: { token: ctx.token.accessToken },
          logger: log,
          operation: 'disconnect.revoke',
        });
        log.info('discord.disconnected', { revoked: true });
        return { revoked: true };
      } catch (error) {
        log.warn('discord.revoke_failed', { errorCode: error instanceof ConnectorError ? error.code : 'unknown' });
        return { revoked: false };
      }
    }

    // OAuth2 credential with no refresh token: nothing to revoke, but the
    // shape IS supported — a soft `revoked: false` is still correct here.
    log.info('discord.disconnected', { revoked: false, reason: 'no-refresh-token' });
    return { revoked: false };
  }

  // ---------------------------------------------------------------------
  private toTokenSet(res: DiscordOAuthTokenResponse): TokenSet {
    const obtainedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + res.expires_in * 1000).toISOString();
    return {
      accessToken: res.access_token,
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      tokenType: res.token_type ?? 'Bearer',
      scopes: res.scope ? res.scope.split(' ') : [],
      expiresAt,
      obtainedAt,
    };
  }
}
