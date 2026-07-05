import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FileSystemPluginLoader, InMemoryPluginRegistry } from '@social/core';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('FileSystemPluginLoader smoke test', () => {
  it('discovers and loads discord/twitch/bluesky .ts plugin entries at runtime', async () => {
    const registry = new InMemoryPluginRegistry();
    const loader = new FileSystemPluginLoader();
    await loader.loadInto(registry, { workspaceRoot });
    expect(registry.has('discord')).toBe(true);
    expect(registry.has('twitch')).toBe(true);
    expect(registry.has('bluesky')).toBe(true);
    const discord = registry.get('discord')!;
    expect(typeof discord.createConnector).toBe('function');
  });
});
