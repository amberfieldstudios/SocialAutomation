-- =============================================================================
-- SocialAutomation — scheduled campaign compose specs (migration 0006)
-- =============================================================================
-- Backs the pipeline package's `scheduleCampaign` (t23/t30): persists the
-- `ComposeAndSubmitInput` (minus `occurrenceKey`, which is per-occurrence) a
-- scheduled/recurring campaign was created with, so `ScheduleMaterializer` can
-- re-run `CampaignService.composeAndSubmit` against it after a process
-- restart -- before this migration the spec lived only in an in-process
-- `Map`, which meant a scheduled campaign silently stopped materializing
-- correctly if the process restarted between creation and its next due
-- occurrence (a different process has an empty Map).
--
-- Modeled as its OWN table (not a column on `schedules`) because:
--   * `schedules` is a generic timing engine (immediate/scheduled/recurring
--     against either a `post_id` or a `post_variant_id`) owned by
--     `@social/scheduler`, which has zero knowledge of `ComposeAndSubmitInput`
--     -- that shape is `@social/pipeline`'s (specifically
--     `campaign-service.ts`). Keeping it in a separate table avoids leaking a
--     pipeline-package concept into the scheduler's generic schema.
--   * Not every `schedules` row is a campaign compose (a schedule can target a
--     single already-composed `post_variant_id` with no compose spec at all),
--     so a NOT NULL column on `schedules` would be wrong and a nullable one
--     would be dead weight for those rows.
--   * A 1:1 child table cascades cleanly on `schedules` deletion and keeps the
--     (potentially large: description/tags/media source paths) JSON blob out
--     of the hot `schedules` table that `listDue()` scans every sweep.
--
-- `compose_spec` is `ComposeAndSubmitInput` (minus `occurrenceKey`) as JSON.
-- It references target accounts/platforms by id ONLY (`platforms[].accountId`
-- / `platforms[].platformId`) -- it MUST NEVER contain an access/refresh token
-- or any other secret; tokens are looked up at materialize time from
-- `account_tokens` via the account id, exactly like every other publish path.
-- =============================================================================

CREATE TABLE scheduled_campaigns (
  schedule_id   TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  compose_spec  TEXT NOT NULL,                    -- JSON: ComposeAndSubmitInput (sans occurrenceKey)
  created_at    TEXT NOT NULL
);
