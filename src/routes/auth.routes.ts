import { Router, Response } from 'express';
import { z } from 'zod';
import { registerUser, loginUser, getAllUsers, getUserById } from '../auth/user.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';
import { emailSchema, validateBody } from '../lib/validate.js';

const router = Router();

const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', validateBody(registerSchema), async (req, res): Promise<void> => {
  try {
    const result = await registerUser(req.body);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Registration failed',
      });
    }
  }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', validateBody(loginSchema), async (req, res): Promise<void> => {
  try {
    const result = await loginUser(req.body);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(401).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Login failed',
      });
    }
  }
});

/**
 * GET /api/auth/me
 * Get current user (requires authentication)
 */
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }

    const user = await getUserById(req.user.userId);

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get user',
    });
  }
});

/**
 * GET /api/auth/users
 * Get all users (requires authentication)
 */
router.get('/users', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await getAllUsers();

    res.json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get users',
    });
  }
});

export default router;
