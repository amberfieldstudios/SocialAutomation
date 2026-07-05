-- =============================================================================
-- SocialAutomation — generic app settings key/value store (migration 0007)
-- =============================================================================
-- Backs small pieces of server-side app state that need to survive a browser
-- refresh AND a process restart (unlike client-only localStorage) — the first
-- consumer is the setup wizard's first-run detection + resume-at-step state
-- (t2): whether the wizard has been completed, and which step a not-yet-
-- completed run last left off at, keyed under `wizard_state` (see
-- `packages/api/src/wizard-state-routes.ts`).
--
-- Modeled as a generic key/value table (not a one-off `wizard_state` table)
-- because this is exactly the shape most small "app-level, not per-account"
-- settings need, and it avoids a migration per future setting. `value` is
-- opaque JSON as far as `@social/db` is concerned, mirroring
-- `scheduled_campaigns.compose_spec` (migration 0006) — this package has no
-- knowledge of the wizard's shape, only that a caller wants a JSON blob
-- durably keyed by a string.
-- =============================================================================

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,             -- JSON
  updated_at  TEXT NOT NULL
);
