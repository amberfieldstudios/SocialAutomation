import { defineConfig } from 'vitest/config';

// Some tests exercise a real SQLite-backed AnalyticsSnapshotsStore (via
// @social/db), same node:sqlite flag story as packages/db and
// packages/pipeline: no flag needed on Node >= 24, --experimental-sqlite on
// Node 22.5-23.x. `pool: 'forks'` keeps that runtime flag scoped to a real
// child process.
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
  },
});
