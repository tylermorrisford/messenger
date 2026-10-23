import { vi } from 'vitest';

vi.mock('../lib/email.js', () => ({
  sendEmail: vi.fn(async () => {}),
}));
