import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import request, { type Response } from 'supertest';
import { vi } from 'vitest';
import type { EmailCodePurpose } from '@prisma/client';
import app from '../server.js';
import { sendEmail } from '../lib/email.js';
import { credentialSigningInput } from '../api/credentials.js';

export const b64 = (bytes: number): string => randomBytes(bytes).toString('base64');

export const KDF = { version: 1, memLimit: 64 * 1024 * 1024, opsLimit: 3 };

export function ed25519Keypair(): { ed25519Pub: string; signingKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // the raw 32-byte key is the tail of the SPKI DER encoding
  const ed25519Pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  return { ed25519Pub, signingKey: privateKey };
}

export function signMessage(signingKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message), signingKey).toString('base64');
}

export function registrationBody(email: string, authKey: string) {
  return {
    email,
    name: 'Alice',
    authKey,
    kdf: KDF,
    x25519Pub: b64(32),
    ed25519Pub: b64(32),
    keyBundle: b64(96),
    keyBundleNonce: b64(24),
    recoveryBundle: b64(96),
    recoveryBundleNonce: b64(24),
  };
}

export function signedCredentials(signingKey: KeyObject) {
  const update = { authKey: b64(32), kdf: KDF, keyBundle: b64(96), keyBundleNonce: b64(24) };

  return { ...update, signature: signMessage(signingKey, credentialSigningInput(update)) };
}

export function lastEmailText(): string {
  const call = vi.mocked(sendEmail).mock.calls.at(-1);

  if (!call) {
    throw new Error('No email was sent');
  }

  return call[0].text;
}

export function refreshCookie(res: Response): string {
  const cookie = res.get('Set-Cookie')?.find((value) => value.startsWith('refresh='));

  if (!cookie) {
    throw new Error('No refresh cookie was set');
  }

  return cookie.split(';')[0];
}

export async function emailProof(email: string, purpose: EmailCodePurpose = 'VERIFY'): Promise<string> {
  await request(app).post('/api/auth/email-code').send({ email, purpose });
  const code = lastEmailText().match(/code is (\d{6})/)?.[1];

  const res = await request(app).post('/api/auth/verify').send({ email, purpose, code });

  return res.body.data.proof;
}

export async function signUp(email: string, authKey = b64(32)) {
  const { ed25519Pub, signingKey } = ed25519Keypair();
  const res = await request(app)
    .post('/api/auth/register')
    .send({ ...registrationBody(email, authKey), ed25519Pub, emailProof: await emailProof(email) });

  if (res.status !== 201) {
    throw new Error(`Sign-up failed: ${JSON.stringify(res.body)}`);
  }

  return {
    authKey,
    signingKey,
    userId: res.body.data.user.id as string,
    accessToken: res.body.data.accessToken as string,
    cookie: refreshCookie(res),
  };
}
