import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://msguser:msgpass123@localhost:5433/messaging_test',
      JWT_SECRET: 'test-only-secret-that-is-at-least-32-chars',
    },
    globalSetup: ['./src/test/global-setup.ts'],
    // every file shares one test database
    fileParallelism: false,
  },
});
