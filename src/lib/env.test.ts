import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('refuses to start without a real JWT_SECRET', async () => {
  vi.stubEnv('JWT_SECRET', '');

  await expect(import('./env.js')).rejects.toThrow(/JWT_SECRET/);
});

it('exposes the parsed environment', async () => {
  const { env } = await import('./env.js');

  expect(env.NODE_ENV).toBe('test');
  expect(env.JWT_EXPIRES_IN).toBe('7d');
});
