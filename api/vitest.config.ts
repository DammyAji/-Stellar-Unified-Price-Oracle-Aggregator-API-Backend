import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'tests/e2e', 'tests/integration'],
    // Keep existing suites that assert on the legacy fallback behaviour able to
    // boot without API_KEYS; production refuses to start without a key source.
    env: { ALLOW_EPHEMERAL_ADMIN_KEY: 'true' },
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'clover'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/routes/admin.ts', 'src/routes/webhooks.ts'],
      thresholds: {
        lines: 32,
        functions: 32,
        branches: 27,
        statements: 33,
      },
    },
  },
});
