/**
 * Plugin discovery, manifest, and registration contract.
 *
 * ── How a plugin is discovered ─────────────────────────────────────────────
 * The loader scans workspace packages (default glob `plugins/*`) for a
 * `package.json` that carries a `socialPlugin` field:
 *
 *   {
 *     "name": "@social/plugin-discord",
 *     "socialPlugin": { "platform": "discord", "contractVersion": "1.0.0" }
 *   }
 *
 * The package's module entry (its `exports`/`main`) MUST default-export a
 * `PluginManifest`. The loader imports it, checks `manifest.contractVersion`
 * against `CONTRACT_VERSION`, verifies `manifest.platform` matches the
 * package.json declaration, and calls `registry.register(manifest)`.
 *
 * At publish time the core resolves a connector purely by platform id
 * (`registry.get('discord')`) — it never imports a plugin package directly.
 */

import type { CapabilityDescriptor } from '../connector/capabilities';
import type { ConnectorFactory } from '../connector/contract';

/** Current PlatformConnector contract version. Bump on breaking changes. */
export const CONTRACT_VERSION = '1.1.0';

/** The `socialPlugin` field shape inside a plugin package's package.json. */
export interface SocialPluginPackageField {
  platform: string;
  contractVersion: string;
  /** Optional explicit module entry; falls back to package `exports`/`main`. */
  entry?: string;
}

/** The runtime object a plugin's module default-exports. */
export interface PluginManifest {
  /** npm package name, e.g. '@social/plugin-discord'. */
  name: string;
  /** Stable platform id — matches CapabilityDescriptor.platform and the DB. */
  platform: string;
  /** Plugin package version (semver). */
  version: string;
  /** Contract version this plugin targets; loader compares to CONTRACT_VERSION. */
  contractVersion: string;
  /** Static capability declaration for the platform. */
  capabilities: CapabilityDescriptor;
  /** Builds the connector instance. */
  createConnector: ConnectorFactory;
}

/**
 * Identity-typed manifest helper: gives plugin authors full type checking while
 * keeping the declaration co-located in `src/index.ts`.
 */
export function defineManifest(manifest: PluginManifest): PluginManifest {
  return manifest;
}

/** In-memory registry the core queries by platform id. */
export interface PluginRegistry {
  register(manifest: PluginManifest): void;
  get(platform: string): PluginManifest | undefined;
  has(platform: string): boolean;
  list(): PluginManifest[];
}

export interface PluginLoaderOptions {
  /** Absolute path to the monorepo root. */
  workspaceRoot: string;
  /** Globs (relative to root) to scan; defaults to ['plugins/*']. */
  pluginGlobs?: string[];
}

export interface DiscoveredPlugin {
  packageName: string;
  packageDir: string;
  entryPath: string;
  manifest: PluginManifest;
}

/** Contract for the concrete loader implemented by the connector-engineer. */
export interface PluginLoader {
  discover(options: PluginLoaderOptions): Promise<DiscoveredPlugin[]>;
  loadInto(registry: PluginRegistry, options: PluginLoaderOptions): Promise<PluginRegistry>;
}
