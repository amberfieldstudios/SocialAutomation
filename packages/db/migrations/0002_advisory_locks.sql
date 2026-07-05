-- =============================================================================
-- SocialAutomation — advisory locks (migration 0002)
-- =============================================================================
-- Portable cross-worker mutual exclusion, used by @social/auth for refresh
-- serialization (docs/AUTH.md §3) and reused by @social/queue (scheduler-queue)
-- for occurrence/claim guards.
--
-- Why a table (and not only pg_advisory_xact_lock):
--   * Postgres prod SHOULD prefer native pg_advisory_xact_lock(hashtext(key)),
--     which is auto-released at transaction end and needs no cleanup.
--   * SQLite dev / any single-writer engine has no advisory-lock primitive; a
--     BEGIN IMMEDIATE transaction serializes writers but does not express a
--     named, TTL-bounded lock across separate operations.
--   * This table is the portable fallback that works identically on both:
--     acquire = INSERT (or takeover of an expired row); release = DELETE.
--
-- Contract (enforced in the @social/db AdvisoryLock adapter, not in SQL):
--   * acquire(key, holder, ttl): succeed iff no live row for `key` exists
--     (no row, or expires_at <= now -> stale, may be taken over). Set
--     acquired_at = now, expires_at = now + ttl, holder = <worker id>.
--   * release(key, holder): DELETE the row iff holder matches (never release
--     someone else's lock).
--   * A holder that outlives its ttl MUST treat its lock as lost.
--
-- Portability follows migration 0001: TEXT keys, ISO-8601 UTC TEXT timestamps
-- supplied by the application, no engine-specific types.
-- =============================================================================

CREATE TABLE advisory_locks (
  lock_key     TEXT PRIMARY KEY,   -- e.g. 'refresh:<account_id>'
  holder       TEXT NOT NULL,      -- worker/process id currently holding the lock
  acquired_at  TEXT NOT NULL,      -- ISO-8601 UTC when the lock was taken
  expires_at   TEXT NOT NULL       -- ISO-8601 UTC; rows at/after this are stale and reclaimable
);

-- Sweep expired locks and look up by holder for takeover/cleanup.
CREATE INDEX idx_advisory_locks_expires ON advisory_locks (expires_at);
CREATE INDEX idx_advisory_locks_holder ON advisory_locks (holder);
