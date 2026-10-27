import { Router } from 'express';
import { findUserByEmail, getUserKeys } from '../auth/user.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { HttpError } from '../lib/http-error.js';
import { emailSchema } from '../lib/validate.js';

const router = Router();

/**
 * GET /api/users?email=
 * Finds a friend by email so the caller can wrap a conversation key for their current public key
 */
router.get('/', authenticate, async (req, res): Promise<void> => {
  const email = emailSchema.safeParse(req.query.email);

  if (!email.success) {
    throw new HttpError(400, 'Invalid email');
  }

  const user = await findUserByEmail(email.data);

  if (!user) {
    throw new HttpError(404, 'No account for that email');
  }

  res.json({ success: true, data: user });
});

/**
 * GET /api/users/:id/keys
 * Every public key a user has ever had, so old signatures still verify after an identity reset
 */
router.get('/:id/keys', authenticate, async (req, res): Promise<void> => {
  const keys = await getUserKeys(req.params.id);

  if (keys.length === 0) {
    throw new HttpError(404, 'User not found');
  }

  res.json({ success: true, data: keys });
});

export default router;
