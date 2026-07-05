-- =============================================================================
-- SocialAutomation — initial schema (migration 0001)
-- =============================================================================
-- Portability contract (SQLite dev / Postgres prod):
--   * Primary keys are application-generated UUID strings (TEXT). We do NOT use
--     AUTOINCREMENT/SERIAL so the DDL is identical across dialects.
--   * Timestamps are ISO-8601 UTC strings in TEXT columns; the application
--     supplies them. (Postgres deployments MAY migrate these to TIMESTAMPTZ.)
--   * Booleans are INTEGER 0/1 with CHECK constraints (SQLite has no BOOLEAN;
--     Postgres accepts INTEGER + CHECK).
--   * JSON payloads live in TEXT columns marked "-- JSON". (Postgres deployments
--     MAY switch these to JSONB.)
--   * SQLite callers MUST run `PRAGMA foreign_keys = ON;` per connection for the
--     FK constraints below to be enforced.
-- Naming: table/column names are the canonical vocabulary shared with
-- docs/SCHEMA.md, the TypeScript types in @social/core, and every worker.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- platforms — one row per installed connector plugin.
-- `capabilities` is a cached JSON snapshot of the plugin's CapabilityDescriptor;
-- the live source of truth is the plugin's capabilities.ts.
-- -----------------------------------------------------------------------------
CREATE TABLE platforms (
  id                TEXT PRIMARY KEY,             -- stable platform id, e.g. 'discord'
  display_name      TEXT NOT NULL,
  api_base_url      TEXT NOT NULL,
  contract_version  TEXT NOT NULL,
  capabilities      TEXT NOT NULL,                -- JSON: CapabilityDescriptor snapshot
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- accounts — multiple accounts per platform, with profile metadata.
-- -----------------------------------------------------------------------------
CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  platform_id       TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  remote_id         TEXT NOT NULL,                -- platform-native account id
  handle            TEXT,
  display_name      TEXT,
  avatar_url        TEXT,
  profile_url       TEXT,
  profile_metadata  TEXT,                         -- JSON: extra profile fields
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disconnected', 'error', 'revoked')),
  connected_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (platform_id, remote_id)
);
CREATE INDEX idx_accounts_platform ON accounts (platform_id);
CREATE INDEX idx_accounts_status ON accounts (status);

-- -----------------------------------------------------------------------------
-- account_tokens — the encrypted token vault.
-- Stores CIPHERTEXT + a key REFERENCE only. Plaintext tokens are NEVER stored
-- here and NEVER logged. Decryption happens in the auth layer at call time.
-- One current token set per account (partial unique index); older rows are
-- retained as rotation history (is_current = 0).
-- -----------------------------------------------------------------------------
CREATE TABLE account_tokens (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  access_token_ciphertext   TEXT NOT NULL,        -- base64/hex ciphertext
  refresh_token_ciphertext  TEXT,                 -- nullable: not all platforms issue one
  encryption_key_ref        TEXT NOT NULL,        -- KMS/key id or vault key name (NOT the key)
  encryption_alg            TEXT NOT NULL DEFAULT 'aes-256-gcm',
  nonce                     TEXT NOT NULL,        -- IV/nonce (base64)
  auth_tag                  TEXT,                 -- AEAD auth tag (base64), when applicable
  token_type                TEXT,                 -- e.g. 'Bearer'
  scopes                    TEXT NOT NULL,        -- JSON array of granted scopes
  expires_at                TEXT,                 -- ISO-8601 access-token expiry (nullable)
  obtained_at               TEXT NOT NULL,
  rotated_at                TEXT,
  is_current                INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX idx_account_tokens_account ON account_tokens (account_id);
CREATE INDEX idx_account_tokens_expires ON account_tokens (expires_at);
-- exactly one current token set per account:
CREATE UNIQUE INDEX uq_account_tokens_current
  ON account_tokens (account_id) WHERE is_current = 1;

-- -----------------------------------------------------------------------------
-- campaigns — a grouping of posts with shared tracking.
-- -----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  tracking_code  TEXT,                            -- campaign id used in UTM/short URLs
  starts_at      TEXT,
  ends_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_campaigns_status ON campaigns (status);

-- -----------------------------------------------------------------------------
-- posts — the single canonical content brief the user authors once.
-- Platform-specific renderings live in post_variants.
-- -----------------------------------------------------------------------------
CREATE TABLE posts (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  title        TEXT,
  brief        TEXT NOT NULL,                     -- the content description / source copy
  link_url     TEXT,                              -- canonical link (pre-UTM)
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'generating', 'ready',
                                   'partially_published', 'published', 'failed', 'archived')),
  created_by   TEXT,                              -- user reference
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_posts_campaign ON posts (campaign_id);
CREATE INDEX idx_posts_status ON posts (status);

-- -----------------------------------------------------------------------------
-- post_variants — one platform-optimized rendering of a post for one account.
-- `payload` is the JSON PostPayload the connector consumes at publish time.
-- -----------------------------------------------------------------------------
CREATE TABLE post_variants (
  id                 TEXT PRIMARY KEY,
  post_id            TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform_id        TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  text               TEXT,
  title              TEXT,
  payload            TEXT NOT NULL,               -- JSON: PostPayload (tags, mentions, thread, options)
  generated_by       TEXT NOT NULL DEFAULT 'ai'
                       CHECK (generated_by IN ('ai', 'manual', 'edited')),
  validation_state   TEXT NOT NULL DEFAULT 'unvalidated'
                       CHECK (validation_state IN ('unvalidated', 'valid', 'invalid', 'warnings')),
  validation_result  TEXT,                        -- JSON: ValidationResult
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'queued', 'publishing',
                                         'published', 'failed', 'deleted')),
  remote_id          TEXT,                        -- platform-native post id after publish
  remote_url         TEXT,
  published_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_post_variants_post ON post_variants (post_id);
CREATE INDEX idx_post_variants_account ON post_variants (account_id);
CREATE INDEX idx_post_variants_status ON post_variants (status);

-- -----------------------------------------------------------------------------
-- media_assets — an uploaded original media item (library entry).
-- -----------------------------------------------------------------------------
CREATE TABLE media_assets (
  id                 TEXT PRIMARY KEY,
  post_id            TEXT REFERENCES posts(id) ON DELETE SET NULL,
  media_type         TEXT NOT NULL
                       CHECK (media_type IN ('image', 'video', 'gif', 'audio', 'document')),
  original_filename  TEXT,
  mime_type          TEXT NOT NULL,
  bytes              INTEGER,
  width              INTEGER,
  height             INTEGER,
  duration_ms        INTEGER,
  checksum           TEXT,                         -- e.g. sha256 hex, for dedupe
  storage_uri        TEXT NOT NULL,                -- file path or object-store URL of the original
  alt_text           TEXT,
  status             TEXT NOT NULL DEFAULT 'ready'
                       CHECK (status IN ('uploading', 'ready', 'failed')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_media_assets_post ON media_assets (post_id);
CREATE INDEX idx_media_assets_checksum ON media_assets (checksum);

-- -----------------------------------------------------------------------------
-- media_renditions — processed variants of an asset (square/portrait/story/...).
-- -----------------------------------------------------------------------------
CREATE TABLE media_renditions (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('original', 'square', 'portrait', 'landscape',
                                 'story', 'thumbnail', 'compressed')),
  mime_type    TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  bytes        INTEGER,
  bitrate      INTEGER,
  storage_uri  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_media_renditions_asset ON media_renditions (asset_id);

-- -----------------------------------------------------------------------------
-- post_variant_media — join: which rendition attaches to which variant, ordered.
-- remote_media_id is filled after a connector's uploadMedia stages the asset.
-- -----------------------------------------------------------------------------
CREATE TABLE post_variant_media (
  id               TEXT PRIMARY KEY,
  post_variant_id  TEXT NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  asset_id         TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  rendition_id     TEXT REFERENCES media_renditions(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  alt_text         TEXT,
  remote_media_id  TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (post_variant_id, position)
);
CREATE INDEX idx_pvm_variant ON post_variant_media (post_variant_id);
CREATE INDEX idx_pvm_asset ON post_variant_media (asset_id);

-- -----------------------------------------------------------------------------
-- schedules — immediate / scheduled / recurring, timezone-aware.
-- A schedule targets either a whole post (fan out to its variants) or one
-- variant. `recurrence_rule` is an RFC 5545 RRULE for mode = 'recurring'.
-- -----------------------------------------------------------------------------
CREATE TABLE schedules (
  id               TEXT PRIMARY KEY,
  post_id          TEXT REFERENCES posts(id) ON DELETE CASCADE,
  post_variant_id  TEXT REFERENCES post_variants(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL
                     CHECK (mode IN ('immediate', 'scheduled', 'recurring')),
  run_at           TEXT,                          -- ISO-8601, for 'scheduled'
  timezone         TEXT NOT NULL DEFAULT 'UTC',   -- IANA tz, e.g. 'Africa/Johannesburg'
  recurrence_rule  TEXT,                          -- RFC 5545 RRULE, for 'recurring'
  next_run_at      TEXT,                          -- computed next fire time (UTC)
  last_run_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'active', 'paused', 'completed', 'cancelled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (post_id IS NOT NULL OR post_variant_id IS NOT NULL)
);
CREATE INDEX idx_schedules_next_run ON schedules (status, next_run_at);
CREATE INDEX idx_schedules_post ON schedules (post_id);
CREATE INDEX idx_schedules_variant ON schedules (post_variant_id);

-- -----------------------------------------------------------------------------
-- publish_jobs — the persisted work queue. Workers claim eligible rows
-- (status='pending' AND available_at <= now), run the connector operation, and
-- update status / attempts / available_at (backoff). idempotency_key prevents
-- double-posting across retries and worker restarts.
-- -----------------------------------------------------------------------------
CREATE TABLE publish_jobs (
  id               TEXT PRIMARY KEY,
  post_variant_id  TEXT NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  schedule_id      TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  operation        TEXT NOT NULL DEFAULT 'publish'
                     CHECK (operation IN ('publish', 'edit', 'delete')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'running',
                                       'succeeded', 'failed', 'dead')),
  idempotency_key  TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  available_at     TEXT NOT NULL,                 -- eligible-to-run time (backoff moves it forward)
  claimed_at       TEXT,
  claimed_by       TEXT,                          -- worker id holding the claim
  last_error       TEXT,
  last_error_code  TEXT,                          -- maps to ConnectorErrorCode
  result           TEXT,                          -- JSON: PublishResult / EditResult / DeleteResult
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_publish_jobs_ready ON publish_jobs (status, available_at);
CREATE INDEX idx_publish_jobs_variant ON publish_jobs (post_variant_id);

-- -----------------------------------------------------------------------------
-- dead_letter_jobs — jobs that exhausted retries. Kept for triage/replay.
-- -----------------------------------------------------------------------------
CREATE TABLE dead_letter_jobs (
  id                TEXT PRIMARY KEY,
  publish_job_id    TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  post_variant_id   TEXT,                         -- denormalized for triage
  operation         TEXT NOT NULL,
  attempts          INTEGER NOT NULL,
  error_code        TEXT,                         -- ConnectorErrorCode
  error_message     TEXT,
  payload_snapshot  TEXT,                         -- JSON: the payload at time of failure
  failed_at         TEXT NOT NULL,
  resolved          INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  resolved_at       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_dlq_job ON dead_letter_jobs (publish_job_id);
CREATE INDEX idx_dlq_resolved ON dead_letter_jobs (resolved);

-- -----------------------------------------------------------------------------
-- analytics_snapshots — point-in-time normalized metrics per published variant.
-- Campaign aggregation rolls these up. `metrics` keys are CanonicalMetric names.
-- -----------------------------------------------------------------------------
CREATE TABLE analytics_snapshots (
  id               TEXT PRIMARY KEY,
  post_variant_id  TEXT NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  account_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  remote_id        TEXT NOT NULL,
  collected_at     TEXT NOT NULL,
  metrics          TEXT NOT NULL,                 -- JSON: Record<CanonicalMetric, number>
  raw              TEXT,                           -- JSON: untyped platform payload
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_analytics_variant_time ON analytics_snapshots (post_variant_id, collected_at);
CREATE INDEX idx_analytics_account ON analytics_snapshots (account_id);

-- -----------------------------------------------------------------------------
-- logs — structured log lines (secrets already redacted at emit time).
-- Optional/append-only; deployments may route to an external log store instead.
-- -----------------------------------------------------------------------------
CREATE TABLE logs (
  id               TEXT PRIMARY KEY,
  ts               TEXT NOT NULL,                 -- ISO-8601 event time
  level            TEXT NOT NULL
                     CHECK (level IN ('trace', 'debug', 'info', 'warn', 'error')),
  logger           TEXT NOT NULL,                 -- emitting module/package name
  message          TEXT NOT NULL,
  fields           TEXT,                          -- JSON: structured context (redacted)
  trace_id         TEXT,                          -- correlation id across a pipeline run
  account_id       TEXT,
  post_variant_id  TEXT,
  publish_job_id   TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_logs_ts ON logs (ts);
CREATE INDEX idx_logs_level ON logs (level);
CREATE INDEX idx_logs_trace ON logs (trace_id);
