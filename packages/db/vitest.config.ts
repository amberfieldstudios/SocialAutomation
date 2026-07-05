import { defineConfig } from 'vitest/config';

// `node:sqlite` (the fallback SQLite engine) is behind `--experimental-sqlite`
// on Node 22.5–23.x and needs no flag on Node >= 24. Pass the flag to the test
// worker only on versions that require it. `pool: 'forks'` is used because node
// runtime flags must be applied to a real child process (thread execArgv is
// restricted to a V8 allowlist).
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
