/**
 * Concrete plugin discovery, validation, and registry implementation for the
 * contract declared in `manifest.ts`.
 *
 * Discovery walks the configured globs (default `plugins/*`), reads each
 * package's `package.json` for a `socialPlugin` marker, imports its module
 * entry, and validates the default-exported `PluginManifest` against
 * `CONTRACT_VERSION` and the capability shape before registering it. Every
 * failure is a structured `PluginLoadError` (never a silent skip of a
 * malformed plugin) so bad plugins are caught at load time, not at publish
 * time.
 */

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTRACT_VERSION } from './manifest';
import type {
  DiscoveredPlugin,
  PluginLoader as PluginLoaderContract,
  PluginLoaderOptions,
  PluginManifest,
  PluginRegistry as PluginRegistryContract,
  SocialPluginPackageField,
} from './manifest';
import type { OperationSupport } from '../connector/capabilities';

const REQUIRED_OPERATIONS: (keyof OperationSupport)[] = [
  'connect',
  'authenticate',
  'refreshToken',
  'validatePost',
  'uploadMedia',
  'publish',
  'delete',
  'edit',
  'getAnalytics',
  'disconnect',
];

export interface PluginLoadErrorOptions {
  packageDir?: string;
  packageName?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Structured error for any plugin discovery/validation/registration failure. */
export class PluginLoadError extends Error {
  readonly packageDir: string | undefined;
  readonly packageName: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: PluginLoadErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PluginLoadError';
    this.packageDir = options.packageDir;
    this.packageName = options.packageName;
    this.details = options.details;
  }
}

/** In-memory `PluginRegistry` keyed by platform id. */
export class InMemoryPluginRegistry implements PluginRegistryContract {
  private readonly manifests = new Map<string, PluginManifest>();

  register(manifest: PluginManifest): void {
    const existing = this.manifests.get(manifest.platform);
    if (existing) {
      throw new PluginLoadError(
        `A plugin is already registered for platform "${manifest.platform}" ` +
          `(existing: ${existing.name}, incoming: ${manifest.name}).`,
        {
          packageName: manifest.name,
          details: { platform: manifest.platform, existing: existing.name, incoming: manifest.name },
        },
      );
    }
    this.manifests.set(manifest.platform, manifest);
  }

  get(platform: string): PluginManifest | undefined {
    return this.manifests.get(platform);
  }

  has(platform: string): boolean {
    return this.manifests.has(platform);
  }

  list(): PluginManifest[] {
    return [...this.manifests.values()];
  }
}

interface RawPackageJson {
  name?: string;
  main?: string;
  exports?: string | Record<string, unknown>;
  socialPlugin?: SocialPluginPackageField;
  [key: string]: unknown;
}

/** Only the `<dir>/*` glob shape is supported (matches this monorepo's layout). */
async function resolveGlobDirs(workspaceRoot: string, glob: string): Promise<string[]> {
  if (!glob.endsWith('/*')) {
    throw new PluginLoadError(`Unsupported plugin glob "${glob}" — only the "<dir>/*" shape is supported.`);
  }
  const parent = path.resolve(workspaceRoot, glob.slice(0, -2));
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    // No such directory yet (e.g. a fresh checkout with no plugins/ dir) is not fatal.
    return [];
  }
  return entries
    .filter((entry: Dirent) => entry.isDirectory())
    .map((entry: Dirent) => path.join(parent, entry.name))
    .sort();
}

function resolveEntryPath(packageDir: string, pkgJson: RawPackageJson, socialPlugin: SocialPluginPackageField): string {
  if (socialPlugin.entry) {
    return path.resolve(packageDir, socialPlugin.entry);
  }
  if (typeof pkgJson.exports === 'string') {
    return path.resolve(packageDir, pkgJson.exports);
  }
  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    const dot = (pkgJson.exports as Record<string, unknown>)['.'];
    if (typeof dot === 'string') {
      return path.resolve(packageDir, dot);
    }
  }
  if (pkgJson.main) {
    return path.resolve(packageDir, pkgJson.main);
  }
  return path.resolve(packageDir, './src/index.ts');
}

function fail(message: string, options: PluginLoadErrorOptions = {}): never {
  throw new PluginLoadError(message, options);
}

/**
 * Validates a loaded manifest against the contract. Throws `PluginLoadError`
 * with a specific reason on the first violation found — plugin authors get an
 * actionable message, and no partially-valid manifest is ever registered.
 */
export function validateManifest(
  manifest: unknown,
  socialPlugin: SocialPluginPackageField,
  context: { packageName?: string; packageDir?: string },
): asserts manifest is PluginManifest {
  const { packageDir } = context;
  const packageName = context.packageName ?? '(unknown package)';

  if (!manifest || typeof manifest !== 'object') {
    fail(`Plugin "${packageName}" entry must default-export a PluginManifest object.`, { packageDir, packageName });
  }
  const m = manifest as Partial<PluginManifest>;

  const missing: string[] = [];
  if (!m.name) missing.push('name');
  if (!m.platform) missing.push('platform');
  if (!m.version) missing.push('version');
  if (!m.contractVersion) missing.push('contractVersion');
  if (!m.capabilities) missing.push('capabilities');
  if (typeof m.createConnector !== 'function') missing.push('createConnector (must be a function)');

  if (missing.length > 0) {
    fail(`Plugin "${packageName}" manifest is missing required field(s): ${missing.join(', ')}.`, {
      packageDir,
      packageName,
      details: { missing },
    });
  }

  const capabilities = m.capabilities!;

  if (m.contractVersion !== CONTRACT_VERSION) {
    fail(
      `Plugin "${m.name}" targets contract version "${m.contractVersion}" but the core contract is ` +
        `"${CONTRACT_VERSION}". Update the plugin (or pin an older core) before it can be registered.`,
      {
        packageDir,
        packageName,
        details: { expected: CONTRACT_VERSION, actual: m.contractVersion },
      },
    );
  }

  if (m.platform !== socialPlugin.platform) {
    fail(
      `Plugin "${m.name}" manifest.platform ("${m.platform}") does not match its package.json ` +
        `socialPlugin.platform ("${socialPlugin.platform}").`,
      { packageDir, packageName, details: { manifestPlatform: m.platform, declaredPlatform: socialPlugin.platform } },
    );
  }

  if (capabilities.platform !== m.platform) {
    fail(
      `Plugin "${m.name}" capabilities.platform ("${capabilities.platform}") does not match ` +
        `manifest.platform ("${m.platform}").`,
      { packageDir, packageName },
    );
  }

  if (capabilities.contractVersion !== undefined && capabilities.contractVersion !== m.contractVersion) {
    fail(
      `Plugin "${m.name}" capabilities.contractVersion ("${capabilities.contractVersion}") does not ` +
        `match manifest.contractVersion ("${m.contractVersion}").`,
      { packageDir, packageName },
    );
  }

  const opsMissing: string[] = [];
  for (const op of REQUIRED_OPERATIONS) {
    if (typeof capabilities.operations?.[op] !== 'boolean') {
      opsMissing.push(op);
    }
  }
  if (opsMissing.length > 0) {
    fail(
      `Plugin "${m.name}" capabilities.operations is missing a boolean flag for: ${opsMissing.join(', ')}.`,
      { packageDir, packageName, details: { opsMissing } },
    );
  }
}

/** Filesystem-based `PluginLoader`: scans `plugins/*`-style workspace globs. */
export class FileSystemPluginLoader implements PluginLoaderContract {
  async discover(options: PluginLoaderOptions): Promise<DiscoveredPlugin[]> {
    const globs = options.pluginGlobs ?? ['plugins/*'];
    const dirLists = await Promise.all(globs.map((glob) => resolveGlobDirs(options.workspaceRoot, glob)));
    const dirs = dirLists.flat();

    const discovered: DiscoveredPlugin[] = [];
    for (const dir of dirs) {
      const pkgJsonPath = path.join(dir, 'package.json');
      let raw: string;
      try {
        raw = await readFile(pkgJsonPath, 'utf8');
      } catch {
        continue; // not a package directory (e.g. stray file/dir under plugins/)
      }

      let pkgJson: RawPackageJson;
      try {
        pkgJson = JSON.parse(raw) as RawPackageJson;
      } catch (cause) {
        fail(`Invalid JSON in "${pkgJsonPath}".`, { packageDir: dir, cause });
      }

      const socialPlugin = pkgJson.socialPlugin;
      if (!socialPlugin) {
        continue; // not a social plugin package
      }

      if (!socialPlugin.platform || !socialPlugin.contractVersion) {
        fail(
          `Plugin package "${pkgJson.name ?? dir}" has an invalid "socialPlugin" field: ` +
            `"platform" and "contractVersion" are both required.`,
          { packageDir: dir, packageName: pkgJson.name, details: { socialPlugin } },
        );
      }

      const entryPath = resolveEntryPath(dir, pkgJson, socialPlugin);
      let mod: { default?: unknown };
      try {
        mod = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
      } catch (cause) {
        fail(`Failed to import plugin entry "${entryPath}" for package "${pkgJson.name ?? dir}".`, {
          packageDir: dir,
          packageName: pkgJson.name,
          cause,
        });
      }

      validateManifest(mod.default, socialPlugin, { packageName: pkgJson.name, packageDir: dir });

      discovered.push({
        packageName: pkgJson.name ?? dir,
        packageDir: dir,
        entryPath,
        manifest: mod.default,
      });
    }
    return discovered;
  }

  async loadInto(registry: PluginRegistryContract, options: PluginLoaderOptions): Promise<PluginRegistryContract> {
    const discovered = await this.discover(options);
    for (const plugin of discovered) {
      registry.register(plugin.manifest);
    }
    return registry;
  }
}
