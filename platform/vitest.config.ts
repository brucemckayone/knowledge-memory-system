import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test file patterns
    include: ['src/test/**/*.test.ts'],

    // Exclude node_modules and dist
    exclude: ['node_modules', 'dist'],

    // Global setup/teardown
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],

    // Environment
    environment: 'node',

    // Environment variables for tests - ensure services use test database
    // Use 127.0.0.1 instead of localhost to avoid IPv6 resolution issues on Windows
    env: {
      DATABASE_URL: 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test',
      NODE_ENV: 'test',
      ML_SERVICES_URL: 'http://127.0.0.1:8000',
      QDRANT_URL: 'http://127.0.0.1:6335',
    },

    // Timeouts - longer for ML service tests
    testTimeout: 30000,
    hookTimeout: 30000,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/test/**',
        'src/types/**',
        'node_modules/**',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },

    // Reporter configuration
    reporters: ['verbose'],

    // Parallel execution - tests must be isolated (query only own data).
    // fileParallelism: false serializes file execution so cross-file
    // cleanup hooks (deleteFromTables, TRUNCATE, broad DELETE FROM…)
    // can't race each other. Tests within a file still run sequentially
    // by default. Trade-off: slower wall clock on clean runs, but no
    // flaky FK violations or global-state collisions.
    pool: 'threads',
    fileParallelism: false,

    // Retry flaky tests (especially ML tests)
    retry: 1,

    // Sequence for deterministic runs
    sequence: {
      shuffle: false,
    },

    // Type checking
    typecheck: {
      enabled: true,
    },
  },

  // ESM resolve
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
