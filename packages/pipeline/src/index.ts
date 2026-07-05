/**
 * @social/pipeline — the m3 capstone: wires the plugin registry, `@social/auth`
 * token vault/account manager, `@social/queue` worker, and `@social/db`
 * persistence into a real end-to-end publish path (see `pipeline.ts` for the
 * full flow diagram).
 */

export { PluginConnectorResolver, ConnectorNotFoundError, type ConnectorResolverOptions } from './connector-resolver';
export { StaticAppCredentialsResolver } from './app-credentials';
export {
  SecureAppCredentialsStore,
  loadOrCreatePersistentKeyProvider,
  resolveUserDataDir,
  type SecureAppCredentialsStoreOptions,
} from './secure-app-credentials';
export { PostVariantsRepo, type PostVariantSeed } from './post-variants-repo';
export { PublishService, type SubmitPostInput, type SubmitPostResult, type PublishJobPayload, type PublishServiceOptions } from './publish-service';
export { createPublishHandler, type PublishHandlerDeps } from './publish-worker';
export { createAnalyticsHandler, type AnalyticsHandlerDeps, type AnalyticsJobPayload } from './analytics-worker';
export {
  buildPipeline,
  defaultWorkspaceRoot,
  type BuildPipelineOptions,
  type Pipeline,
  type PipelineScheduler,
  type PipelineAnalytics,
  type ScheduleCampaignInput,
  type EnqueueAnalyticsCollectionInput,
} from './pipeline';
export {
  CampaignService,
  type CampaignPlatformTarget,
  type ComposeAndSubmitInput,
  type CampaignResult,
  type PlatformCampaignResult,
  type PlatformCampaignStatus,
  type CampaignServiceOptions,
} from './campaign-service';
