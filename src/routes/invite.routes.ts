import { Router } from 'express';
import { z } from 'zod';
import { createInvite, findOpenInvite } from '../api/invites.js';
import { authenticate, requireUser } from '../middleware/auth.middleware.js';
import { inviteLimiter } from '../middleware/rate-limit.middleware.js';
import { HttpError } from '../lib/http-error.js';
import { emailSchema, validateBody } from '../lib/validate.js';

const router = Router();

const inviteSchema = z.object({
  email: emailSchema,
});

/**
 * POST /api/invites
 * Emails a sign-up link to someone without an account
 */
router.post('/', authenticate, inviteLimiter, validateBody(inviteSchema), async (req, res): Promise<void> => {
  const invite = await createInvite(requireUser(req).userId, req.body.email);

  res.status(201).json({ success: true, data: invite });
});

/**
 * GET /api/invites/:token
 * Lets the sign-up page show which email the invite is locked to
 */
router.get('/:token', async (req, res): Promise<void> => {
  const invite = await findOpenInvite(req.params.token);

  if (!invite) {
    throw new HttpError(404, 'This invite is invalid or has expired');
  }

  res.json({ success: true, data: { email: invite.email, expiresAt: invite.expiresAt } });
});

export default router;
