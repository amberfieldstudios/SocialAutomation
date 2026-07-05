/**
 * Pluggable short-URL tracking.
 *
 * `ShortUrlProvider` is the seam every URL shortener (local or external)
 * implements. `LocalShortUrlService` is the verified path: it persists the
 * slug -> target mapping (+ campaign/platform/account context) via the
 * `ShortUrlsStore` port (`@social/db`'s `SqliteShortUrlsStore` structurally
 * satisfies it — no direct dependency needed, same pattern as
 * `AnalyticsSnapshotsStore` in `collector.ts`). `resolve()` is the click-
 * attribution path: given a slug, it records the click and returns the
 * target + campaignId so a redirect handler can 302 the visitor AND log which
 * campaign the click belongs to.
 *
 * A real external provider (Bitly, TinyURL, a company-internal shortener) is
 * a plain implementation of `ShortUrlProvider` — `ExternalShortUrlProvider`
 * below is only a documented stub/interface shape, not wired into anything by
 * default.
 */

import { randomBytes } from 'node:crypto';
import type { StructuredLogger } from '@social/core';

export interface CreateTrackedUrlInput {
  /** The (ideally already UTM-tagged) URL the short link should redirect to. */
  targetUrl: string;
  /** Tracking code used for click attribution — need not be a `campaigns.id` FK. */
  campaignId?: string;
  platform?: string;
  accountId?: string;
  /** Request a specific slug instead of a random one (e.g. a vanity link). Must be unique. */
  slug?: string;
}

export interface TrackedUrl {
  slug: string;
  /** The full short URL a client should be given, e.g. `https://trk.local/AbC123`. */
  shortUrl: string;
  targetUrl: string;
  campaignId?: string;
}

export interface ResolvedShortUrl {
  slug: string;
  targetUrl: string;
  campaignId?: string;
  platform?: string;
  accountId?: string;
  clickCount: number;
}

/** The seam every short-URL backend (local or a real external service) implements. */
export interface ShortUrlProvider {
  readonly name: string;
  createShortUrl(input: CreateTrackedUrlInput): Promise<TrackedUrl>;
  /** Resolve a slug to its target, recording the click for attribution. Returns `undefined` for an unknown slug. */
  resolve(slug: string): Promise<ResolvedShortUrl | undefined>;
}

/** Minimal storage port `LocalShortUrlService` depends on — satisfied structurally by `@social/db`'s `ShortUrlsStore`. */
export interface ShortUrlsStorePort {
  create(input: {
    slug: string;
    targetUrl: string;
    campaignId?: string | null;
    platformId?: string | null;
    accountId?: string | null;
  }): Promise<{ slug: string; targetUrl: string; campaignId: string | null }>;
  findBySlug(slug: string): Promise<{ slug: string; targetUrl: string } | undefined>;
  recordClick(slug: string): Promise<
    | {
        slug: string;
        targetUrl: string;
        campaignId: string | null;
        platformId: string | null;
        accountId: string | null;
        clickCount: number;
      }
    | undefined
  >;
}

export interface LocalShortUrlServiceOptions {
  store: ShortUrlsStorePort;
  logger: StructuredLogger;
  /** Domain the generated short URLs are served from. Default `https://trk.local` (a placeholder — swap for the real deployed redirect host). */
  baseUrl?: string;
  /** Slug length for randomly generated slugs. Default 7. */
  slugLength?: number;
  /** Max attempts to find a free random slug before giving up. Default 5. */
  maxCollisionRetries?: number;
}

const SLUG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomSlug(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

/** The verified short-URL path: persists slug -> target (+campaign) mappings via `@social/db`. */
export class LocalShortUrlService implements ShortUrlProvider {
  readonly name = 'local';
  private readonly baseUrl: string;
  private readonly slugLength: number;
  private readonly maxCollisionRetries: number;
  private readonly logger: StructuredLogger;

  constructor(private readonly options: LocalShortUrlServiceOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://trk.local').replace(/\/+$/, '');
    this.slugLength = options.slugLength ?? 7;
    this.maxCollisionRetries = options.maxCollisionRetries ?? 5;
    this.logger = options.logger.child({ module: 'analytics.short_url' });
  }

  async createShortUrl(input: CreateTrackedUrlInput): Promise<TrackedUrl> {
    const slug = input.slug ?? (await this.pickFreeSlug());
    const record = await this.options.store.create({
      slug,
      targetUrl: input.targetUrl,
      campaignId: input.campaignId ?? null,
      platformId: input.platform ?? null,
      accountId: input.accountId ?? null,
    });

    this.logger.info('analytics.short_url.created', {
      slug,
      campaignId: record.campaignId ?? undefined,
      platform: input.platform,
      // Never log the full target URL if it could carry sensitive query params beyond UTM tags;
      // the host is enough for a useful log line, the mapping itself lives in the DB.
      targetHost: safeHost(input.targetUrl),
    });

    return {
      slug,
      shortUrl: `${this.baseUrl}/${slug}`,
      targetUrl: record.targetUrl,
      ...(record.campaignId ? { campaignId: record.campaignId } : {}),
    };
  }

  async resolve(slug: string): Promise<ResolvedShortUrl | undefined> {
    const clicked = await this.options.store.recordClick(slug);
    if (!clicked) {
      this.logger.warn('analytics.short_url.resolve_unknown_slug', { slug });
      return undefined;
    }
    this.logger.info('analytics.short_url.click_attributed', {
      slug,
      campaignId: clicked.campaignId ?? undefined,
      platform: clicked.platformId ?? undefined,
      clickCount: clicked.clickCount,
    });
    return {
      slug: clicked.slug,
      targetUrl: clicked.targetUrl,
      ...(clicked.campaignId ? { campaignId: clicked.campaignId } : {}),
      ...(clicked.platformId ? { platform: clicked.platformId } : {}),
      ...(clicked.accountId ? { accountId: clicked.accountId } : {}),
      clickCount: clicked.clickCount,
    };
  }

  private async pickFreeSlug(): Promise<string> {
    for (let attempt = 0; attempt < this.maxCollisionRetries; attempt++) {
      const candidate = randomSlug(this.slugLength);
      const existing = await this.options.store.findBySlug(candidate);
      if (!existing) return candidate;
      this.logger.warn('analytics.short_url.slug_collision', { attempt });
    }
    throw new Error(`LocalShortUrlService: could not find a free slug after ${this.maxCollisionRetries} attempts`);
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Documented stub for a real external short-URL provider (Bitly, TinyURL, a
 * company-internal shortener). Not wired into anything by default — a real
 * implementation would call the provider's API in `createShortUrl` and either
 * proxy `resolve()` through the provider's own click-analytics API or rely on
 * the provider's redirect (in which case click attribution happens on
 * whatever webhook/analytics the provider offers instead of `resolve()`).
 */
export abstract class ExternalShortUrlProvider implements ShortUrlProvider {
  abstract readonly name: string;
  abstract createShortUrl(input: CreateTrackedUrlInput): Promise<TrackedUrl>;
  abstract resolve(slug: string): Promise<ResolvedShortUrl | undefined>;
}
