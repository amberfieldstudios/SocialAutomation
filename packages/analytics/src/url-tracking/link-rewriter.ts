/**
 * LinkRewriter — the step `CampaignService` (per t18/t21) applies to a
 * campaign's outbound link before generation, so the text every connector
 * eventually publishes already carries a tracked URL.
 *
 * Per docs/PLATFORM-RULES.md, none of the current connectors (Discord,
 * Twitch, Bluesky) auto-shorten or discount URL length — every character of
 * a link counts against the platform's own text/title/grapheme limit. That
 * makes shortening strictly beneficial once a `ShortUrlProvider` is
 * available: a compact `https://trk.local/AbC123` is safe headroom for
 * Bluesky's 300-grapheme post / Twitch's 140-char title, and it is still a
 * valid absolute URL for Bluesky's link-facet auto-detection (any
 * `https?://` run of non-whitespace becomes a `#link` facet — see
 * `plugins/bluesky/src/richtext.ts`).
 *
 * Policy: always UTM-tag the link first (so the *target* stays attributable
 * even if the short-URL step is skipped), then shorten it through the
 * injected `ShortUrlProvider` if one was configured. No provider -> the
 * caller gets the UTM-tagged URL as-is (still attributable via the plain
 * `utm_*` params, just not shortened).
 */

import type { StructuredLogger } from '@social/core';
import { buildUtmUrl } from './utm';
import type { ShortUrlProvider } from './short-url-service';

export interface LinkRewriteContext {
  /** The target platform id, e.g. `twitch`, `bluesky`, `discord` — used as `utm_source` unless overridden. */
  platform: string;
  /** Internal account id being posted from — used as `utm_content` for per-account attribution. */
  accountId?: string;
  /** Campaign tracking code — used as `utm_campaign` and propagated onto the short-URL mapping for click attribution. */
  campaignId?: string;
  /** Override `utm_source`. Defaults to `platform`. */
  source?: string;
  /** Override `utm_medium`. Defaults to `'social'`. */
  medium?: string;
  /** Optional `utm_term`. */
  term?: string;
}

export interface LinkRewriterOptions {
  logger: StructuredLogger;
  /** When present, every rewritten link is also shortened through this provider. Omit to only UTM-tag. */
  shortUrlService?: ShortUrlProvider;
  defaultMedium?: string;
  /** Fallback `utm_campaign` value when no `campaignId` is supplied on the context. */
  defaultCampaign?: string;
}

const UNTRACKED_CAMPAIGN = 'uncampaigned';

/**
 * Rewrites campaign links to tracked (UTM-tagged, optionally shortened) URLs.
 * Pluggable and injected — `CampaignService` only calls this when a
 * `LinkRewriter` instance is supplied, so callers/tests that don't care about
 * tracking are completely unaffected.
 */
export class LinkRewriter {
  private readonly logger: StructuredLogger;

  constructor(private readonly options: LinkRewriterOptions) {
    this.logger = options.logger.child({ module: 'analytics.link_rewriter' });
  }

  /**
   * Rewrite one link. Never mutates `url` in place — always returns a new
   * string. Throws only if `url` is not a valid absolute URL (callers should
   * decide whether that's fatal or a fall-back-to-original condition; see
   * `CampaignService`'s guarded call site).
   */
  async rewriteLink(url: string, ctx: LinkRewriteContext): Promise<string> {
    const campaign = ctx.campaignId ?? this.options.defaultCampaign ?? UNTRACKED_CAMPAIGN;
    const utmUrl = buildUtmUrl(url, {
      source: ctx.source ?? ctx.platform,
      medium: ctx.medium ?? this.options.defaultMedium ?? 'social',
      campaign,
      ...(ctx.accountId !== undefined ? { content: ctx.accountId } : {}),
      ...(ctx.term !== undefined ? { term: ctx.term } : {}),
    });

    if (!this.options.shortUrlService) {
      this.logger.info('link_rewriter.tagged', { platform: ctx.platform, campaign });
      return utmUrl;
    }

    const tracked = await this.options.shortUrlService.createShortUrl({
      targetUrl: utmUrl,
      campaignId: campaign,
      platform: ctx.platform,
      ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
    });

    this.logger.info('link_rewriter.shortened', {
      platform: ctx.platform,
      campaign,
      slug: tracked.slug,
    });
    return tracked.shortUrl;
  }
}
