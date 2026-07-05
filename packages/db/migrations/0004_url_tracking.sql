-- =============================================================================
-- SocialAutomation — URL tracking (migration 0004)
-- =============================================================================
-- Backs @social/analytics's LocalShortUrlService (t21): a slug -> target-URL
-- mapping used both to mint tracked short links (LinkRewriter) and to resolve
-- a clicked slug back to the campaign that owns it (click attribution).
--
-- `target_url` is expected to already be UTM-tagged by the caller (see
-- `buildUtmUrl`/`LinkRewriter`) — this table does not itself tag URLs, it only
-- maps a short slug to whatever target it was created against, plus the
-- campaign/platform/account context needed for attribution.
--
-- `click_count`/`last_clicked_at` are updated in place on every `resolve()`
-- call (best-effort click counting, not a durable per-click event log — a
-- future `link_clicks` append-only table can be layered on if per-click detail
-- is ever needed without touching this shape).
-- =============================================================================

CREATE TABLE short_urls (
  slug             TEXT PRIMARY KEY,
  target_url       TEXT NOT NULL,
  campaign_id      TEXT,                 -- free-form tracking code, not necessarily campaigns.id
  platform_id      TEXT,
  account_id       TEXT,
  click_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_clicked_at  TEXT
);

CREATE INDEX idx_short_urls_campaign ON short_urls (campaign_id);
CREATE INDEX idx_short_urls_platform ON short_urls (platform_id);
