/**
 * REST support for first-run detection + wizard resume (t2).
 *
 * Persisted server-side in `@social/db`'s generic `app_settings` key/value
 * store (migration 0007) under the key `wizard_state` — NOT localStorage —
 * so a browser refresh or a full app restart resumes at the same step
 * (docs/AUTH.md-adjacent requirement from the board: "not just localStorage").
 *
 * Semantics (deliberately simple):
 *  - `completed: false` (the default, before anything is ever saved) means
 *    "show the wizard" — the dashboard opens on the Setup wizard tab and the
 *    wizard opens on `currentStepId`, so an abandoned run resumes exactly
 *    where it left off, across both a refresh and a restart.
 *  - `completed: true` is set once the user reaches the wizard's "done" step.
 *    From then on the dashboard opens on its normal default tab and the
 *    wizard never auto-shows again — but the "Setup wizard" tab always stays
 *    in the tablist (see `packages/ui/src/App.tsx`), and `POST .../restart`
 *    (surfaced as "Run setup again" in the Accounts view) flips `completed`
 *    back to `false` on demand.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

const SETTINGS_KEY = 'wizard_state';

export interface WizardState {
  completed: boolean;
  currentStepId: string;
  updatedAt: string;
}

const DEFAULT_STATE: WizardState = { completed: false, currentStepId: 'welcome', updatedAt: new Date(0).toISOString() };

function readState(ctx: AppContext): WizardState {
  return ctx.db.settings.get<WizardState>(SETTINGS_KEY) ?? DEFAULT_STATE;
}

function writeState(ctx: AppContext, patch: Partial<Pick<WizardState, 'completed' | 'currentStepId'>>): WizardState {
  const next: WizardState = { ...readState(ctx), ...patch, updatedAt: new Date().toISOString() };
  ctx.db.settings.set(SETTINGS_KEY, next);
  return next;
}

export function registerWizardStateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/wizard-state', async () => readState(ctx));

  app.put('/api/wizard-state', async (req, reply) => {
    const body = req.body as { currentStepId?: string; completed?: boolean };
    if (body?.currentStepId !== undefined && typeof body.currentStepId !== 'string') {
      return reply.status(400).send({ error: 'currentStepId must be a string' });
    }
    if (body?.completed !== undefined && typeof body.completed !== 'boolean') {
      return reply.status(400).send({ error: 'completed must be a boolean' });
    }
    const patch: Partial<Pick<WizardState, 'completed' | 'currentStepId'>> = {};
    if (body?.currentStepId !== undefined) patch.currentStepId = body.currentStepId;
    if (body?.completed !== undefined) patch.completed = body.completed;
    return writeState(ctx, patch);
  });

  /** "Run setup again" (Accounts view): re-arms first-run detection without touching any connected account. */
  app.post('/api/wizard-state/restart', async () => writeState(ctx, { completed: false, currentStepId: 'welcome' }));
}
