/**
 * The publish job handler: resolves the connector + a decrypted
 * `OperationContext` for the job's account, then calls the connector's
 * `publish`/`edit`/`delete` per `job.operation`. Thrown connector errors
 * propagate untouched so `@social/queue`'s `Worker` can apply its existing
 * retry/backoff/dead-letter routing (`isRetryable` reads the same typed
 * errors every connector already throws) — this handler makes no retry
 * decisions itself.
 */

import type { PublishJobRecord } from '@social/queue';
import type { AccountManager } from '@social/auth';
import type { PluginConnectorResolver } from './connector-resolver';
import type { PublishJobPayload } from './publish-service';

export interface PublishHandlerDeps {
  connectors: PluginConnectorResolver;
  accounts: AccountManager;
}

function parsePayload(job: PublishJobRecord): PublishJobPayload {
  const payload = job.payload as Partial<PublishJobPayload> | undefined;
  if (!payload || typeof payload.platform !== 'string' || typeof payload.accountId !== 'string' || !payload.postPayload) {
    throw new Error(`Publish job ${job.id} has a malformed payload; expected { platform, accountId, postPayload }.`);
  }
  return payload as PublishJobPayload;
}

/** Builds the `JobHandler` a `Worker` drives jobs through. */
export function createPublishHandler(deps: PublishHandlerDeps) {
  return async (job: PublishJobRecord): Promise<unknown> => {
    const { platform, accountId, postPayload } = parsePayload(job);
    const connector = deps.connectors.resolve(platform);
    const ctx = await deps.accounts.createContext(accountId);

    switch (job.operation) {
      case 'publish':
        return connector.publish(postPayload, ctx);
      case 'edit':
        return connector.edit({ remoteId: postPayload.idempotencyKey ?? '', payload: postPayload }, ctx);
      case 'delete':
        return connector.delete({ remoteId: postPayload.idempotencyKey ?? '' }, ctx);
      default:
        throw new Error(`Unsupported job operation "${job.operation as string}".`);
    }
  };
}
