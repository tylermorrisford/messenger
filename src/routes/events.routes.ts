import { Router } from 'express';
import { subscribe } from '../api/events.js';
import { listen } from '../lib/notify.js';
import { authenticate, requireUser } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// under most proxy idle timeouts
const HEARTBEAT_MS = 25_000;

/**
 * GET /api/events
 * Server-sent events for every conversation the caller is in; ends when the access token expires
 */
router.get('/', async (req, res): Promise<void> => {
  const { userId, expiresAt } = requireUser(req);
  await listen();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const expiry = setTimeout(() => res.end(), Math.max(0, expiresAt - Date.now()));
  const unsubscribe = subscribe(userId, ({ event, data }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });

  res.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
  });
});

export default router;
