-- =============================================================================
-- SocialAutomation — allow 'collect_analytics' as a publish_jobs.operation (migration 0005)
-- =============================================================================
-- `@social/queue`'s `JobOperation` union (packages/queue/src/types.ts) added
-- `'collect_analytics'` in the m2-hardening pass (t22) so scheduled analytics
-- collection can run through the SAME queue machinery (claim/retry/backoff/
-- DLQ) as publish/edit/delete jobs, instead of a bespoke interval timer (see
-- `@social/analytics`'s `ScheduledCollectionRunner` doc comment, which flagged
-- this exact gap). `0001_init.sql`'s `publish_jobs.operation` CHECK constraint
-- was never updated to match, so any `collect_analytics` job insert fails with
-- `CHECK constraint failed: operation IN ('publish', 'edit', 'delete')` — a
-- genuine cross-package wiring gap discovered while wiring `@social/pipeline`'s
-- `collect_analytics` job handler through to a real DB (t23).
--
-- SQLite has no `ALTER TABLE ... DROP/ALTER CONSTRAINT`, so the CHECK is
-- widened via the standard rebuild-and-rename pattern: create a new table with
-- the corrected CHECK (identical columns, including the `payload` column added
-- by 0003), copy every row across, drop the old table, and rename the new one
-- into place. This runs inside the migrator's own transaction; `DROP TABLE`
-- does not itself enforce/cascade foreign keys in SQLite (FK checks apply only
-- to DML, not DDL), and `dead_letter_jobs.publish_job_id`'s reference to
-- `publish_jobs(id)` resolves correctly again as soon as the rebuilt table
-- (same name, same ids) is renamed into place before commit.
-- =============================================================================

CREATE TABLE publish_jobs_new (
  id               TEXT PRIMARY KEY,
  post_variant_id  TEXT NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  schedule_id      TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  operation        TEXT NOT NULL DEFAULT 'publish'
                     CHECK (operation IN ('publish', 'edit', 'delete', 'collect_analytics')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'running',
                                       'succeeded', 'failed', 'dead')),
  idempotency_key  TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  available_at     TEXT NOT NULL,
  claimed_at       TEXT,
  claimed_by       TEXT,
  last_error       TEXT,
  last_error_code  TEXT,
  result           TEXT,
  payload          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (idempotency_key)
);

INSERT INTO publish_jobs_new (
  id, post_variant_id, schedule_id, operation, status, idempotency_key,
  attempts, max_attempts, available_at, claimed_at, claimed_by,
  last_error, last_error_code, result, payload, created_at, updated_at
)
SELECT
  id, post_variant_id, schedule_id, operation, status, idempotency_key,
  attempts, max_attempts, available_at, claimed_at, claimed_by,
  last_error, last_error_code, result, payload, created_at, updated_at
FROM publish_jobs;

DROP TABLE publish_jobs;
ALTER TABLE publish_jobs_new RENAME TO publish_jobs;

CREATE INDEX idx_publish_jobs_ready ON publish_jobs (status, available_at);
CREATE INDEX idx_publish_jobs_variant ON publish_jobs (post_variant_id);
