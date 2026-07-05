/**
 * REST support for the setup wizard (t1): connecting a platform account and
 * testing an existing connection.
 *
 * Three shapes of pairing, matching docs/AUTH.md §6/§10.2:
 *  - Redirect (`authorize_url`): twitch, reddit, mastodon. `begin` returns an
 *    authorize URL the wizard opens in a new tab; the platform redirects the
 *    user's browser to `GET /api/accounts/pair/callback/:platformId`, which
 *    completes the exchange server-side and records the outcome for the
 *    wizard tab to pick up via `poll`.
 *  - Direct password (`platform_password`): bluesky (handle + app password).
 *  - Direct token (`platform_token`): discord (bot token or webhook URL).
 *
 * Every response here is secret-free: `AccountSummary` never carries a token,
 * and error messages are the auth layer's already-generic messages (never
 * echo a raw code/token/secret back to the client).
 */

import type { FastifyInstance } from 'fastify';
import { AuthLayerError, PairingResultError, PairingStateError, UnsupportedGrantError } from '@social/auth';
import type { ConnectorOperation } from '@social/core';
import type { AppContext } from './context';

/** Requests never send an empty operations list; publish-only is the wizard's default. */
const DEFAULT_OPERATIONS: ConnectorOperation[] = ['publish'];

function messageFor(err: unknown): string {
  if (err instanceof PairingStateError) {
    return err.reason === 'expired'
      ? 'That connection attempt took too long and expired. Please try connecting again.'
      : "We couldn't verify that connection attempt. Please try connecting again.";
  }
  if (err instanceof UnsupportedGrantError) {
    return `That connection method isn't available for this platform. Please use the option shown in the wizard.`;
  }
  if (err instanceof PairingResultError) {
    return "The platform didn't send back what we needed to finish connecting. Please try again.";
  }
  if (err instanceof AuthLayerError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function registerPairingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { pairing, pairingOutcomes } = ctx;

  // -------------------------------------------------------------------------
  // Developer-app credentials (Twitch / Reddit / Mastodon "app registration")
  // -------------------------------------------------------------------------

  /**
   * Save the Client ID/Secret (and, for Mastodon, the instance URL) a streamer
   * copy-pasted from the platform's own developer console, per the wizard's
   * guided steps. Never echoed back — `GET` below only reports whether a
   * platform has credentials saved, not their values.
   */
  app.post('/api/app-credentials', async (req, reply) => {
    const body = req.body as {
      platformId: string;
      clientId: string;
      clientSecret?: string;
      redirectUri?: string;
      instanceUrl?: string;
    };
    if (!body?.platformId || !body?.clientId) {
      return reply.status(400).send({ error: 'platformId and clientId are required' });
    }
    const credentials = {
      clientId: body.clientId,
      ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}),
      ...(body.redirectUri ? { redirectUri: body.redirectUri } : {}),
      ...(body.instanceUrl ? { extra: { instanceUrl: body.instanceUrl } } : {}),
    };
    // In-memory (immediate effect for this running process) AND persisted,
    // encrypted at rest (t15, QG-2) — so a restart doesn't lose the app
    // secret and silently break token refresh for this platform.
    ctx.pipeline.appCredentials.set(body.platformId, credentials);
    await ctx.pipeline.secureAppCredentials.set(body.platformId, credentials);
    return reply.status(204).send();
  });

  app.get('/api/app-credentials/:platformId', async (req) => {
    const { platformId } = req.params as { platformId: string };
    return { platformId, configured: ctx.pipeline.appCredentials.has(platformId) };
  });

  // -------------------------------------------------------------------------
  // Redirect (authorize-code / PKCE) pairing: twitch, reddit, mastodon
  // -------------------------------------------------------------------------

  app.post('/api/accounts/pair/begin', async (req, reply) => {
    const body = req.body as { platformId?: string; operations?: ConnectorOperation[] };
    if (!body?.platformId) return reply.status(400).send({ error: 'platformId is required' });
    try {
      const result = await pairing.beginPairing(body.platformId, body.operations ?? DEFAULT_OPERATIONS);
      if (result.kind === 'authorize_url') pairingOutcomes.begin(result.state);
      return result;
    } catch (err) {
      return reply.status(400).send({ error: messageFor(err) });
    }
  });

  /**
   * The platform redirects the user's browser here after they approve access.
   * Renders a small plain-language page instead of raw JSON, since a real
   * browser navigation lands on this URL directly (docs/AUTH.md §6 sequence:
   * "Plat->>API: redirect to callback").
   */
  app.get('/api/accounts/pair/callback/:platformId', async (req, reply) => {
    const { code, state, error: platformError } = req.query as { code?: string; state?: string; error?: string };
    reply.type('text/html');
    if (platformError) {
      if (state) pairingOutcomes.fail(state, 'The platform reported that access was not granted.');
      return reply.send(callbackPage('Connection cancelled', 'You can close this tab and try again from the wizard.'));
    }
    if (!code || !state) {
      return reply.send(callbackPage('Something went wrong', 'This link is missing information we need. Please try connecting again from the wizard.'));
    }
    try {
      const account = await pairing.completePairing(state, code);
      pairingOutcomes.succeed(state, account);
      return reply.send(callbackPage('Connected!', 'You can close this tab and go back to the setup wizard.'));
    } catch (err) {
      pairingOutcomes.fail(state, messageFor(err));
      return reply.send(callbackPage('Connection failed', messageFor(err)));
    }
  });

  /** The wizard polls this while a redirect flow's tab is open elsewhere. */
  app.get('/api/accounts/pair/poll/:state', async (req) => {
    const { state } = req.params as { state: string };
    return pairingOutcomes.peek(state);
  });

  // -------------------------------------------------------------------------
  // Direct flows: bluesky (app password), discord (bot token / webhook)
  // -------------------------------------------------------------------------

  app.post('/api/accounts/pair/password', async (req, reply) => {
    const body = req.body as { platformId?: string; identifier?: string; password?: string; operations?: ConnectorOperation[] };
    if (!body?.platformId || !body?.identifier || !body?.password) {
      return reply.status(400).send({ error: 'platformId, identifier, and password are required' });
    }
    try {
      const account = await pairing.pairWithPassword(body.platformId, {
        identifier: body.identifier,
        password: body.password,
        operations: body.operations ?? DEFAULT_OPERATIONS,
      });
      return reply.status(201).send({ account });
    } catch (err) {
      return reply.status(400).send({ error: messageFor(err) });
    }
  });

  app.post('/api/accounts/pair/token', async (req, reply) => {
    const body = req.body as {
      platformId?: string;
      token?: string;
      tokenType?: string;
      remoteId?: string;
      handle?: string;
      displayName?: string;
    };
    if (!body?.platformId || !body?.token || !body?.tokenType) {
      return reply.status(400).send({ error: 'platformId, token, and tokenType are required' });
    }
    try {
      const account = await pairing.pairWithToken(body.platformId, {
        token: body.token,
        tokenType: body.tokenType,
        profile: {
          remoteId: body.remoteId ?? `${body.platformId}-${body.tokenType}-${Date.now()}`,
          ...(body.handle ? { handle: body.handle } : {}),
          ...(body.displayName ? { displayName: body.displayName } : {}),
        },
      });
      return reply.status(201).send({ account });
    } catch (err) {
      return reply.status(400).send({ error: messageFor(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Test this connection (per-account, plain-language result)
  // -------------------------------------------------------------------------

  app.post('/api/accounts/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await ctx.pipeline.accountManager.getAccount(id);
    if (!account) return reply.status(404).send({ error: 'account not found' });
    try {
      const opCtx = await ctx.pipeline.tokenManager.createContext(id);
      const connector = ctx.pipeline.connectors.resolve(account.platformId);
      const result = await connector.connect({ app: opCtx.app, accountId: id, token: opCtx.token });
      if (result.ready) {
        return { ok: true, message: `${account.displayName ?? account.handle ?? 'This account'} is connected and ready to post.` };
      }
      return { ok: false, message: "We reached the platform, but it says this account isn't ready yet. Try reconnecting." };
    } catch (err) {
      return {
        ok: false,
        message: `We couldn't confirm this connection: ${messageFor(err)}`,
      };
    }
  });
}

function callbackPage(title: string, body: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, sans-serif; background: #14151a; color: #f2f2f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  main { max-width: 28rem; text-align: center; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p>${esc(body)}</p>
</main>
</body>
</html>`;
}
