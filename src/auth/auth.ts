import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { EmailCodePurpose } from '@prisma/client';
import { env } from '../lib/env.js';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') },
      format: 'jwk',
    });

    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ sid: claims.sessionId }, env.JWT_SECRET, {
    subject: claims.userId,
    audience: 'access',
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { audience: 'access' });

    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      return null;
    }

    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

export function signEmailProof(email: string, purpose: EmailCodePurpose): string {
  return jwt.sign({ purpose }, env.JWT_SECRET, {
    subject: email,
    audience: 'email-proof',
    expiresIn: '15m',
  });
}

export function verifyEmailProof(token: string, purpose: EmailCodePurpose): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { audience: 'email-proof' });

    if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.purpose !== purpose) {
      return null;
    }

    return payload.sub;
  } catch {
    return null;
  }
}
