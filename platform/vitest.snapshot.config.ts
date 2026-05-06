/**
 * Dedicated vitest config for snapshot-loading tests.
 *
 * Doc 28 §3.6 / cold-eyes review B5: snapshot tests must run serially because
 * pg_restore --clean --if-exists requires no active connections to the target
 * DB, and the default vitest setup at src/test/setup.ts:55 opens a connection
 * pool in beforeAll. Running snapshot restoration concurrently with that pool
 * fails with "database is being accessed by other users."
 *
 * Convention: snapshot-loading test files end in `.snapshot.test.ts`. The
 * default vitest.config.ts excludes that suffix.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.snapshot.test.ts'],
    exclude: ['node_modules', 'dist'],
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    environment: 'node',
    env: {
      DATABASE_URL: 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test',
      NODE_ENV: 'test',
      ML_SERVICES_URL: 'http://127.0.0.1:8000',
      QDRANT_URL: 'http://127.0.0.1:6335',
    },
    testTimeout: 120000,
    hookTimeout: 120000,
    reporters: ['verbose'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    sequence: {
      shuffle: false,
    },
    retry: 0,
    typecheck: {
      enabled: false,
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
