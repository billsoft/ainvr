import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/test/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
