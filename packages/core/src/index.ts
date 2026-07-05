/**
 * @social/core — the platform-agnostic heart of the system.
 *
 * Exposes the PlatformConnector contract, capability model, typed errors,
 * shared logging shape, and the plugin manifest/registry types. Contains NO
 * platform-specific code.
 */

export * from './logging';
export * from './connector/index';
export * from './plugin/manifest';
export * from './plugin/loader';
export * from './config';
