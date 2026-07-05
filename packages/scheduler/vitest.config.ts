import { defineConfig } from 'vitest/config';

// Schedule materialization is tested against a real SQLite DB (via @social/db),
// same node:sqlite version gate as packages/db and packages/pipeline.
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
