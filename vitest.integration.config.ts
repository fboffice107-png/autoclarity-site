import { defineConfig } from 'vitest/config';

// Integration suite: boots `wrangler pages dev` (fresh local D1 + R2) plus a
// mock Stripe API, then exercises the HTTP surface end to end.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
