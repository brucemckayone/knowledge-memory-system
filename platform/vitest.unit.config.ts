import { defineConfig } from 'vitest/config';

// Pure unit tests — no DB, no infra, fast feedback during implementation.
// Files use the *.unit.test.ts suffix (mirrors the *.snapshot.test.ts split).
// Crucially: NO globalSetup (the default config's global-setup.ts connects to
// Postgres + runs migrations) and NO setupFiles, so these run with zero infra.
// Integration tests (live DB) stay under vitest.config.ts; benchmark/litmus
// runs need the full stack and are out of scope here.
export default defineConfig({
  test: {
    include: ['src/test/**/*.unit.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    pool: 'threads',
    typecheck: { enabled: false },
  },
  resolve: {
    alias: { '@': './src' },
  },
});
