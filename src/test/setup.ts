import { beforeEach, vi } from 'vitest';
import { resetRateLimits } from '../middleware/rate-limit.middleware.js';

vi.mock('../lib/email.js', () => ({
  sendEmail: vi.fn(async () => {}),
}));

beforeEach(() => {
  resetRateLimits();
});
