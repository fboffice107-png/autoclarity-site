import { defineConfig } from 'vitest/config';

// Unit tests only. Integration tests (real local server) run via
// vitest.integration.config.ts — `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
