import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { EmailCodePurpose } from '@prisma/client';
import { getKdfParams, getUserById, loginUser, registerUser } from '../auth/user.js';
import { createSession, REFRESH_TTL_MS, revokeSession, rotateSession } from '../api/sessions.js';
import { issueEmailCode, verifyEmailCode } from '../api/email-codes.js';
import { changePassword, getRecoveryBundle, recoverAccount, resetIdentity } from '../api/credentials.js';
import { authenticate, requireUser } from '../middleware/auth.middleware.js';
import { credentialsLimiter, emailCodeLimiter } from '../middleware/rate-limit.middleware.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http-error.js';
import { base64Schema, emailSchema, kdfSchema, key32Schema, signatureSchema, validateBody } from '../lib/validate.js';

const router = Router();

const REFRESH_COOKIE = 'refresh';

// strict is fine because the app and the API are subdomains of one site; the path keeps it off every other route
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/auth',
};

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions, maxAge: REFRESH_TTL_MS });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
}

const registerSchema = z.object({
  email: emailSchema,
  name: z.string().optional(),
  authKey: key32Schema,
  kdf: kdfSchema,
  x25519Pub: key32Schema,
  ed25519Pub: key32Schema,
  keyBundle: base64Schema,
  keyBundleNonce: base64Schema,
  recoveryBundle: base64Schema,
  recoveryBundleNonce: base64Schema,
  inviteToken: z.string().min(1).optional(),
  emailProof: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  authKey: key32Schema,
});

const emailCodeSchema = z.object({
  email: emailSchema,
  purpose: z.enum(EmailCodePurpose),
});

const verifySchema = emailCodeSchema.extend({
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

/**
 * GET /api/auth/params?email=
 * KDF parameters to derive the auth key with; defaults for unknown emails so existence does not leak
 */
router.get('/params', async (req, res): Promise<void> => {
  const email = emailSchema.safeParse(req.query.email);

  if (!email.success) {
    throw new HttpError(400, 'A valid email is required');
  }

  res.json({ success: true, data: { kdf: await getKdfParams(email.data) } });
});

/**
 * POST /api/auth/register
 * Needs an invite token, or a VERIFY email proof when REGISTRATION_MODE=open
 */
router.post('/register', credentialsLimiter, validateBody(registerSchema), async (req, res): Promise<void> => {
  const user = await registerUser(req.body);
  const session = await createSession(user.id, req.headers['user-agent']);

  setRefreshCookie(res, session.refreshToken);
  res.status(201).json({ success: true, data: { accessToken: session.accessToken, user } });
});

/**
 * POST /api/auth/login
 */
router.post('/login', credentialsLimiter, validateBody(loginSchema), async (req, res): Promise<void> => {
  const result = await loginUser(req.body);
  const session = await createSession(result.user.id, req.headers['user-agent']);

  setRefreshCookie(res, session.refreshToken);
  res.json({ success: true, data: { accessToken: session.accessToken, ...result } });
});

/**
 * POST /api/auth/refresh
 * Rotates the refresh cookie and returns a fresh access token
 */
router.post('/refresh', async (req, res): Promise<void> => {
  const token: unknown = req.cookies[REFRESH_COOKIE];
  const rotated = typeof token === 'string' ? await rotateSession(token) : null;

  if (!rotated) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Session expired');
  }

  if (rotated.refreshToken) {
    setRefreshCookie(res, rotated.refreshToken);
  }

  res.json({ success: true, data: { accessToken: rotated.accessToken } });
});

/**
 * DELETE /api/auth/refresh
 * Logout: revokes the session behind the cookie
 */
router.delete('/refresh', async (req, res): Promise<void> => {
  const token: unknown = req.cookies[REFRESH_COOKIE];

  if (typeof token === 'string') {
    await revokeSession(token);
  }

  clearRefreshCookie(res);
  res.status(204).end();
});

/**
 * POST /api/auth/email-code
 * Emails a 6-digit code; always answers 200 so it cannot be used to probe for accounts
 */
router.post('/email-code', emailCodeLimiter, validateBody(emailCodeSchema), async (req, res): Promise<void> => {
  await issueEmailCode(req.body.email, req.body.purpose);

  res.json({ success: true });
});

/**
 * POST /api/auth/verify
 * Trades a code for a short-lived proof that the caller controls the email
 */
router.post('/verify', credentialsLimiter, validateBody(verifySchema), async (req, res): Promise<void> => {
  const proof = await verifyEmailCode(req.body.email, req.body.purpose, req.body.code);

  res.json({ success: true, data: { proof } });
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, async (req, res): Promise<void> => {
  const user = await getUserById(requireUser(req).userId);

  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  res.json({ success: true, data: user });
});

const credentialSchema = z.object({
  authKey: key32Schema,
  kdf: kdfSchema,
  keyBundle: base64Schema,
  keyBundleNonce: base64Schema,
});

const signedCredentialSchema = credentialSchema.extend({ signature: signatureSchema });

const proofSchema = z.object({ emailProof: z.string().min(1) });

const recoverSchema = signedCredentialSchema.extend(proofSchema.shape);

const resetIdentitySchema = credentialSchema.extend({
  ...proofSchema.shape,
  x25519Pub: key32Schema,
  ed25519Pub: key32Schema,
  recoveryBundle: base64Schema,
  recoveryBundleNonce: base64Schema,
});

/**
 * PUT /api/auth/password
 * New auth key and re-encrypted key bundle, signed by the current identity key; other sessions are logged out
 */
router.put('/password', authenticate, validateBody(signedCredentialSchema), async (req, res): Promise<void> => {
  const { userId, sessionId } = requireUser(req);
  await changePassword(userId, sessionId, req.body);

  res.status(204).end();
});

/**
 * POST /api/auth/recover/bundle
 * The key bundle sealed under the recovery key, for a caller holding a RECOVER proof
 */
router.post('/recover/bundle', credentialsLimiter, validateBody(proofSchema), async (req, res): Promise<void> => {
  res.json({ success: true, data: await getRecoveryBundle(req.body.emailProof) });
});

/**
 * POST /api/auth/recover
 * Forgot password: new credentials signed by the identity key unlocked with the recovery key; every session is logged out
 */
router.post('/recover', credentialsLimiter, validateBody(recoverSchema), async (req, res): Promise<void> => {
  const { emailProof, ...update } = req.body;
  const user = await recoverAccount(emailProof, update);
  const session = await createSession(user.id, req.headers['user-agent']);

  setRefreshCookie(res, session.refreshToken);
  res.json({ success: true, data: { accessToken: session.accessToken, user } });
});

/**
 * POST /api/auth/reset-identity
 * Lost recovery key: brand new identity keys, old ones retired, every session logged out
 */
router.post('/reset-identity', credentialsLimiter, validateBody(resetIdentitySchema), async (req, res): Promise<void> => {
  const { emailProof, ...reset } = req.body;
  const user = await resetIdentity(emailProof, reset);
  const session = await createSession(user.id, req.headers['user-agent']);

  setRefreshCookie(res, session.refreshToken);
  res.json({ success: true, data: { accessToken: session.accessToken, user } });
});

export default router;
