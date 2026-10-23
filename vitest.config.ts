import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://msguser:msgpass123@localhost:5433/messaging_test',
      JWT_SECRET: 'test-only-secret-that-is-at-least-32-chars',
      REGISTRATION_MODE: 'open',
    },
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // every file shares one test database
    fileParallelism: false,
  },
});
