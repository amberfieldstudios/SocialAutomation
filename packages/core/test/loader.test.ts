import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTRACT_VERSION } from '../src/plugin/manifest';
import { FileSystemPluginLoader, InMemoryPluginRegistry, PluginLoadError } from '../src/plugin/loader';

const ALL_OPS_TRUE = {
  connect: true,
  authenticate: true,
  refreshToken: true,
  validatePost: true,
  uploadMedia: true,
  publish: true,
  delete: true,
  edit: true,
  getAnalytics: true,
  disconnect: true,
};

function capabilitiesSource(platform: string, contractVersion: string): string {
  return `{
    platform: ${JSON.stringify(platform)},
    displayName: ${JSON.stringify(platform)},
    apiBaseUrl: 'https://example.invalid/api',
    contractVersion: ${JSON.stringify(contractVersion)},
    operations: ${JSON.stringify(ALL_OPS_TRUE)},
    supportsEdit: true,
    supportsDelete: true,
    supportsScheduling: false,
    supportsThreads: false,
    supportsAnalytics: true,
    supportsMediaUpload: true,
    characterLimit: 500,
    urlsCountTowardLimit: true,
    maxMediaCount: 4,
    supportedMediaTypes: ['image'],
    mediaConstraints: [],
  }`;
}

function writePlugin(
  root: string,
  dirName: string,
  opts: {
    packageName?: string;
    platform: string;
    packageContractVersion?: string;
    manifestContractVersion?: string;
    manifestPlatform?: string;
    capabilitiesPlatform?: string;
    omitCreateConnector?: boolean;
  },
): void {
  const pluginDir = path.join(root, 'plugins', dirName);
  mkdirSync(pluginDir, { recursive: true });

  const packageName = opts.packageName ?? `@social/plugin-${dirName}`;
  const packageContractVersion = opts.packageContractVersion ?? CONTRACT_VERSION;
  const manifestContractVersion = opts.manifestContractVersion ?? CONTRACT_VERSION;
  const manifestPlatform = opts.manifestPlatform ?? opts.platform;
  const capabilitiesPlatform = opts.capabilitiesPlatform ?? manifestPlatform;

  writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.1.0',
        type: 'module',
        main: './index.mjs',
        socialPlugin: { platform: opts.platform, contractVersion: packageContractVersion },
      },
      null,
      2,
    ),
  );

  const createConnectorLine = opts.omitCreateConnector
    ? ''
    : `  createConnector: () => ({ capabilities, } ),\n`;

  writeFileSync(
    path.join(pluginDir, 'index.mjs'),
    `const capabilities = ${capabilitiesSource(capabilitiesPlatform, packageContractVersion)};
export default {
  name: ${JSON.stringify(packageName)},
  platform: ${JSON.stringify(manifestPlatform)},
  version: '0.1.0',
  contractVersion: ${JSON.stringify(manifestContractVersion)},
  capabilities,
${createConnectorLine}};
`,
  );
}

describe('FileSystemPluginLoader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'social-plugin-loader-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers and registers a valid plugin manifest', async () => {
    writePlugin(root, 'good', { platform: 'good' });

    const loader = new FileSystemPluginLoader();
    const registry = new InMemoryPluginRegistry();
    await loader.loadInto(registry, { workspaceRoot: root });

    expect(registry.has('good')).toBe(true);
    const manifest = registry.get('good');
    expect(manifest?.name).toBe('@social/plugin-good');
    expect(manifest?.contractVersion).toBe(CONTRACT_VERSION);
    expect(registry.list()).toHaveLength(1);
  });

  it('ignores workspace packages that do not carry the socialPlugin marker', async () => {
    const plainDir = path.join(root, 'plugins', 'not-a-plugin');
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(
      path.join(plainDir, 'package.json'),
      JSON.stringify({ name: '@social/not-a-plugin', version: '0.1.0' }),
    );

    const loader = new FileSystemPluginLoader();
    const discovered = await loader.discover({ workspaceRoot: root });
    expect(discovered).toHaveLength(0);
  });

  it('rejects a plugin whose manifest.contractVersion does not match CONTRACT_VERSION', async () => {
    writePlugin(root, 'stale', {
      platform: 'stale',
      packageContractVersion: '0.9.0',
      manifestContractVersion: '0.9.0',
    });

    const loader = new FileSystemPluginLoader();
    const registry = new InMemoryPluginRegistry();

    await expect(loader.loadInto(registry, { workspaceRoot: root })).rejects.toThrow(PluginLoadError);
    await expect(loader.loadInto(registry, { workspaceRoot: root })).rejects.toThrow(/contract version/i);
    expect(registry.has('stale')).toBe(false);
  });

  it('rejects a plugin whose manifest.platform disagrees with package.json socialPlugin.platform', async () => {
    writePlugin(root, 'mismatched', { platform: 'mismatched', manifestPlatform: 'other' });

    const loader = new FileSystemPluginLoader();
    const registry = new InMemoryPluginRegistry();

    await expect(loader.loadInto(registry, { workspaceRoot: root })).rejects.toThrow(/does not match/i);
  });

  it('rejects a plugin missing createConnector', async () => {
    writePlugin(root, 'incomplete', { platform: 'incomplete', omitCreateConnector: true });

    const loader = new FileSystemPluginLoader();
    const registry = new InMemoryPluginRegistry();

    await expect(loader.loadInto(registry, { workspaceRoot: root })).rejects.toThrow(/createConnector/);
  });

  it('rejects two plugins registering the same platform id', async () => {
    writePlugin(root, 'dup-a', { platform: 'dup', packageName: '@social/plugin-dup-a' });
    writePlugin(root, 'dup-b', { platform: 'dup', packageName: '@social/plugin-dup-b' });

    const loader = new FileSystemPluginLoader();
    const registry = new InMemoryPluginRegistry();

    await expect(loader.loadInto(registry, { workspaceRoot: root })).rejects.toThrow(/already registered/i);
  });

  it('returns an empty list when the plugins directory does not exist', async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'social-plugin-empty-'));
    const loader = new FileSystemPluginLoader();
    const discovered = await loader.discover({ workspaceRoot: emptyRoot });
    expect(discovered).toEqual([]);
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});
