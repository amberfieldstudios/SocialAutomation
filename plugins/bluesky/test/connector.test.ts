/**
 * Conformance-style tests for the Bluesky connector: contract completeness,
 * validate-before-publish, capability honesty, auth discipline, rate-limit
 * mapping, and logging redaction. All HTTP is mocked — no real credentials,
 * no network calls, per the "official API only, mocked in tests" rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotSupportedError,
  RateLimitError,
  TokenRevokedError,
  ValidationFailedError,
  type ConnectorOperation,
  type PlatformConnector,
} from '@social/core';
import { BlueskyConnector } from '../src/connector';
import { capabilities } from '../src/capabilities';
import { buildFacets, graphemeLength, utf8ByteLength } from '../src/richtext';
import { fakeJwt, jsonResponse, makeCtx, makeLogger, makeToken, mockFetchSequence } from './support';

const REQUIRED_OPS: ConnectorOperation[] = [
  'connect',
  'authenticate',
  'refreshToken',
  'validatePost',
  'uploadMedia',
  'publish',
  'delete',
  'edit',
  'getAnalytics',
  'disconnect',
];

function makeConnector(): PlatformConnector {
  return new BlueskyConnector({ logger: makeLogger() });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capability descriptor', () => {
  it('declares every contract operation as a boolean', () => {
    const connector = makeConnector();
    for (const op of REQUIRED_OPS) {
      expect(typeof connector.capabilities.operations[op]).toBe('boolean');
    }
  });

  it('matches platform id and declares edit unsupported (AT Proto posts are immutable)', () => {
    expect(capabilities.platform).toBe('bluesky');
    expect(capabilities.operations.edit).toBe(false);
    expect(capabilities.supportsEdit).toBe(false);
  });

  it('declares getAnalytics supported (engagement counts are public API data)', () => {
    expect(capabilities.operations.getAnalytics).toBe(true);
    expect(capabilities.supportsAnalytics).toBe(true);
  });
});

describe('richtext helpers', () => {
  it('counts graphemes, not UTF-16 code units (emoji safety)', () => {
    expect(graphemeLength('👨‍👩‍👧‍👦')).toBe(1); // one grapheme cluster, many code units
    expect(graphemeLength('abc')).toBe(3);
  });

  it('computes UTF-8 byte length distinct from grapheme length', () => {
    expect(utf8ByteLength('café')).toBe(5); // é is 2 bytes in UTF-8
    expect(graphemeLength('café')).toBe(4);
  });

  it('builds byte-indexed facets for links and hashtags', async () => {
    const text = 'check #bluesky https://example.com/x';
    const facets = await buildFacets(text, async () => undefined);
    const tag = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#tag');
    const link = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#link');
    expect(tag).toBeDefined();
    expect(link).toBeDefined();
    // byteEnd must land exactly on the substring boundary for both facets.
    const bytes = new TextEncoder().encode(text);
    const tagText = new TextDecoder().decode(bytes.slice(tag!.index.byteStart, tag!.index.byteEnd));
    expect(tagText).toBe('#bluesky');
    const linkText = new TextDecoder().decode(bytes.slice(link!.index.byteStart, link!.index.byteEnd));
    expect(linkText).toBe('https://example.com/x');
  });

  it('drops mention facets whose handle fails to resolve to a DID', async () => {
    const facets = await buildFacets('hello @nobody.example.com', async () => undefined);
    expect(facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#mention')).toBeUndefined();
  });

  it('resolves mention facets when a DID is found', async () => {
    const facets = await buildFacets('hello @person.example.com', async () => 'did:plc:abc123');
    const mention = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#mention');
    expect(mention).toBeDefined();
    expect((mention!.features[0] as { did: string }).did).toBe('did:plc:abc123');
  });
});

describe('validatePost', () => {
  it('accepts a normal short post', async () => {
    const connector = makeConnector();
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1', text: 'hello world' });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects text over 300 graphemes', async () => {
    const connector = makeConnector();
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1', text: 'x'.repeat(301) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'text_too_long')).toBe(true);
  });

  it('rejects an empty post with no text and no media', async () => {
    const connector = makeConnector();
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'empty_post')).toBe(true);
  });

  it('rejects more than 4 images', async () => {
    const connector = makeConnector();
    const media = Array.from({ length: 5 }, (_, i) => ({
      assetId: `m${i}`,
      mimeType: 'image/png',
      uri: `/tmp/${i}.png`,
      bytes: 1000,
    }));
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1', text: 'hi', media });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'too_many_media')).toBe(true);
  });

  it('rejects mixing images and video in one post', async () => {
    const connector = makeConnector();
    const media = [
      { assetId: 'img', mimeType: 'image/png', uri: '/tmp/a.png', bytes: 1000 },
      { assetId: 'vid', mimeType: 'video/mp4', uri: '/tmp/a.mp4', bytes: 1000, durationMs: 1000 },
    ];
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1', text: 'hi', media });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'mixed_media_types')).toBe(true);
  });

  it('rejects an image over the byte-size limit', async () => {
    const connector = makeConnector();
    const media = [{ assetId: 'img', mimeType: 'image/png', uri: '/tmp/a.png', bytes: 5_000_000 }];
    const result = await connector.validatePost({ platform: 'bluesky', accountId: 'a1', text: 'hi', media });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'media_too_large')).toBe(true);
  });
});

describe('authenticate / refreshToken', () => {
  it('exchanges handle + app password for a session via createSession', async () => {
    const connector = makeConnector();
    const { fn, calls } = mockFetchSequence([
      async () => jsonResponse({ accessJwt: fakeJwt('did:plc:abc'), refreshJwt: 'r1', handle: 'me.bsky.social', did: 'did:plc:abc' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const result = await connector.authenticate({
      kind: 'password',
      app: { clientId: 'unused' },
      identifier: 'me.bsky.social',
      password: 'xxxx-xxxx-xxxx-xxxx',
    });

    expect(result.token?.accessToken).toContain('.');
    expect(result.profile?.remoteId).toBe('did:plc:abc');
    expect(calls[0]?.url).toContain('com.atproto.server.createSession');
    // The app password must never appear in the request URL (only in the JSON body, over HTTPS).
    expect(calls[0]?.url).not.toContain('xxxx-xxxx-xxxx-xxxx');
  });

  it('rejects authorize_url/exchange_code kinds with a clear error (no redirect step exists)', async () => {
    const connector = makeConnector();
    await expect(
      connector.authenticate({ kind: 'authorize_url', app: { clientId: 'x' }, state: 's', scopes: [] }),
    ).rejects.toThrow(/app-password/i);
  });

  it('maps a revoked refresh session to TokenRevokedError', async () => {
    const connector = makeConnector();
    const { fn } = mockFetchSequence([async () => jsonResponse({ error: 'InvalidToken', message: 'bad' }, 400)]);
    vi.stubGlobal('fetch', fn);

    await expect(connector.refreshToken({ app: { clientId: 'x' }, token: makeToken() })).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it('rotates the session on successful refresh', async () => {
    const connector = makeConnector();
    const { fn } = mockFetchSequence([
      async () => jsonResponse({ accessJwt: fakeJwt('did:plc:abc'), refreshJwt: 'r2', handle: 'me.bsky.social', did: 'did:plc:abc' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const token = await connector.refreshToken({ app: { clientId: 'x' }, token: makeToken() });
    expect(token.refreshToken).toBe('r2');
  });
});

describe('publish', () => {
  it('refuses to call the network when validatePost would reject (validate-before-publish)', async () => {
    const connector = makeConnector();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(connector.publish({ platform: 'bluesky', accountId: 'a1', text: 'x'.repeat(400) }, makeCtx())).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('publishes a plain text post and returns the AT-URI as remoteId', async () => {
    const connector = makeConnector();
    const { fn, calls } = mockFetchSequence([
      async () => jsonResponse({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/abc123', cid: 'bafycid1' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const result = await connector.publish({ platform: 'bluesky', accountId: 'a1', text: 'hello bluesky' }, makeCtx());
    expect(result.remoteId).toBe('at://did:plc:testaccount/app.bsky.feed.post/abc123');
    expect(result.remoteUrl).toContain('bsky.app/profile/');
    expect(calls[0]?.url).toContain('com.atproto.repo.createRecord');
  });

  it('publishes a thread as sequential replies and returns all remote ids', async () => {
    const connector = makeConnector();
    const { fn } = mockFetchSequence([
      async () => jsonResponse({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/root1', cid: 'cid-root' }),
      async () => jsonResponse({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/reply1', cid: 'cid-reply' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const result = await connector.publish(
      {
        platform: 'bluesky',
        accountId: 'a1',
        text: 'part one',
        thread: [{ platform: 'bluesky', accountId: 'a1', text: 'part two' }],
      },
      makeCtx(),
    );
    expect(result.threadRemoteIds).toHaveLength(2);
  });

  it('maps a 429 response to a retryable RateLimitError', async () => {
    const connector = makeConnector();
    const { fn } = mockFetchSequence([async () => jsonResponse({ error: 'RateLimitExceeded' }, 429, { 'retry-after': '30' })]);
    vi.stubGlobal('fetch', fn);

    const err = await connector.publish({ platform: 'bluesky', accountId: 'a1', text: 'hi' }, makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });
});

describe('delete / edit', () => {
  it('deletes a post via deleteRecord', async () => {
    const connector = makeConnector();
    const { fn, calls } = mockFetchSequence([async () => jsonResponse({})]);
    vi.stubGlobal('fetch', fn);

    const result = await connector.delete({ remoteId: 'at://did:plc:testaccount/app.bsky.feed.post/abc123' }, makeCtx());
    expect(result.removed).toBe(true);
    expect(calls[0]?.url).toContain('com.atproto.repo.deleteRecord');
  });

  it('throws NotSupportedError for edit, matching the capability descriptor', async () => {
    const connector = makeConnector();
    await expect(
      connector.edit({ remoteId: 'x', payload: { platform: 'bluesky', accountId: 'a1', text: 'edited' } }, makeCtx()),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe('getAnalytics', () => {
  it('maps engagement counts onto canonical metrics', async () => {
    const connector = makeConnector();
    const { fn } = mockFetchSequence([
      async () =>
        jsonResponse({
          posts: [{ uri: 'at://x/app.bsky.feed.post/1', cid: 'c1', likeCount: 5, repostCount: 2, replyCount: 1, quoteCount: 0 }],
        }),
    ]);
    vi.stubGlobal('fetch', fn);

    const snapshot = await connector.getAnalytics({ remoteId: 'at://x/app.bsky.feed.post/1' }, makeCtx());
    expect(snapshot.metrics.likes).toBe(5);
    expect(snapshot.metrics.shares).toBe(2);
    expect(snapshot.metrics.comments).toBe(1);
  });
});

describe('disconnect', () => {
  it('revokes the session via deleteSession when a refresh token is present', async () => {
    const connector = makeConnector();
    const { fn, calls } = mockFetchSequence([async () => jsonResponse({})]);
    vi.stubGlobal('fetch', fn);

    const result = await connector.disconnect(makeCtx());
    expect(result.revoked).toBe(true);
    expect(calls[0]?.url).toContain('com.atproto.server.deleteSession');
  });

  it('returns revoked:false without a network call when there is no refresh token', async () => {
    const connector = makeConnector();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await connector.disconnect(makeCtx({ token: makeToken({ refreshToken: undefined }) }));
    expect(result.revoked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('logging redaction', () => {
  it('never writes the raw access/refresh token to a log line', async () => {
    const lines: string[] = [];
    const connector = new BlueskyConnector({ logger: makeLogger((l) => lines.push(l)) });
    const { fn } = mockFetchSequence([
      async () => jsonResponse({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/abc123', cid: 'bafycid1' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const token = makeToken();
    await connector.publish({ platform: 'bluesky', accountId: 'a1', text: 'hello' }, makeCtx({ token }));

    const joined = lines.join('\n');
    expect(joined).not.toContain(token.accessToken);
    expect(joined).not.toContain(token.refreshToken!);
  });
});
