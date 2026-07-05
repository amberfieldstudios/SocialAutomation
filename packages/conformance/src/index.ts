/**
 * @social/conformance — the shared PlatformConnector conformance harness.
 *
 * Any connector plugin runs the full contract suite with a single call in its
 * `test/conformance.test.ts`:
 *
 *   import manifest from '../src/index';
 *   import { runConformance } from '@social/conformance';
 *   runConformance(manifest.createConnector, manifest.capabilities, mockEnv);
 *
 * The harness is platform-agnostic: it knows only the contract in @social/core.
 * All platform specifics (fixtures + a canned HTTP responder) live in the
 * plugin's `ConformanceMockEnv`.
 */

export { runConformance, ALL_OPERATIONS } from './run-conformance';
export type { RunConformanceOptions } from './run-conformance';
export { CapturingLogger, installFetch, hostOf, serializeRequests } from './mock-http';
export type { CapturedLine, InstalledFetch } from './mock-http';
export type { ConformanceMockEnv, RoutedRequest, RouteScenario } from './types';
