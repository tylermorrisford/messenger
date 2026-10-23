import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type AccessClaims } from '../auth/auth.js';
import { HttpError } from '../lib/http-error.js';

declare global {
  namespace Express {
    interface Request {
      user?: AccessClaims;
    }
  }
}

/**
 * Middleware to authenticate requests using JWT
 * Expects: Authorization: Bearer <token>
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const claims = token ? verifyAccessToken(token) : null;

  if (!claims) {
    res.status(401).json({
      success: false,
      error: 'Invalid or missing access token',
    });
    return;
  }

  req.user = claims;
  next();
}

export function requireUser(req: Request): AccessClaims {
  if (!req.user) {
    throw new HttpError(401, 'Not authenticated');
  }

  return req.user;
}
