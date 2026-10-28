import { MemoryStore, rateLimit, type Options } from 'express-rate-limit';
import { requireUser } from './auth.middleware.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// counts live in each API pod, so the real ceiling is limit × replicas; a shared store is the upgrade
const stores: MemoryStore[] = [];

function limiter(options: Partial<Options>) {
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    ...options,
    store,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts, try again later' },
  });
}

export const credentialsLimiter = limiter({ windowMs: FIFTEEN_MINUTES, limit: 10 });

// each call sends an email
export const emailCodeLimiter = limiter({ windowMs: FIFTEEN_MINUTES, limit: 5 });

// signed-in caller, so count per user instead of per address
export const inviteLimiter = limiter({ windowMs: ONE_HOUR, limit: 20, keyGenerator: (req) => requireUser(req).userId });

// tests all come from one address
export function resetRateLimits(): void {
  for (const store of stores) {
    store.resetAll();
  }
}
