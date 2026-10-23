import { Router } from 'express';
import { getUserKeys } from '../auth/user.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { HttpError } from '../lib/http-error.js';

const router = Router();

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
