import { defineConfig } from 'vitest/config';

// Publish jobs are persisted against a real SQLite DB per test (via @social/db).
// `node:sqlite` needs `--experimental-sqlite` on Node 22.5-23.x and no flag on
// Node >= 24 (mirrors packages/db/vitest.config.ts). `pool: 'forks'` isolates
// each test file's global fetch/undici-dispatcher stubbing (discord uses
// undici's MockAgent, twitch/bluesky stub global fetch) from the others.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const execArgv = nodeMajor < 24 ? ['--experimental-sqlite'] : [];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { execArgv },
    },
    testTimeout: 20000,
  },
});
