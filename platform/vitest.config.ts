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

    // Parallel execution - tests must be isolated (query only own data)
    pool: 'threads',

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
