import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';
import { b64, ed25519Keypair, emailProof, KDF, refreshCookie, registrationBody, signedCredentials, signUp } from '../test/helpers.js';

const alice = 'alice@example.com';

beforeEach(async () => {
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PUT /api/auth/password', () => {
  it('replaces the auth key and key bundle and logs out other sessions', async () => {
    const { authKey, signingKey, accessToken, cookie } = await signUp(alice);
    const other = await request(app).post('/api/auth/login').send({ email: alice, authKey });
    const update = signedCredentials(signingKey);

    const res = await request(app).put('/api/auth/password').set('Authorization', `Bearer ${accessToken}`).send(update);

    expect(res.status).toBe(204);

    expect((await request(app).post('/api/auth/login').send({ email: alice, authKey })).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: alice, authKey: update.authKey });
    expect(login.status).toBe(200);
    expect(login.body.data.keyBundle).toBe(update.keyBundle);

    expect((await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(other))).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(200);
  });

  it('rejects an update signed by a different key', async () => {
    const { accessToken } = await signUp(alice);
    const update = signedCredentials(ed25519Keypair().signingKey);

    const res = await request(app).put('/api/auth/password').set('Authorization', `Bearer ${accessToken}`).send(update);

    expect(res.status).toBe(403);
  });

  it('rejects values changed after signing', async () => {
    const { signingKey, accessToken } = await signUp(alice);
    const update = { ...signedCredentials(signingKey), keyBundle: b64(96) };

    const res = await request(app).put('/api/auth/password').set('Authorization', `Bearer ${accessToken}`).send(update);

    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const { signingKey } = await signUp(alice);

    const res = await request(app).put('/api/auth/password').send(signedCredentials(signingKey));

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/recover/bundle', () => {
  it('returns the recovery bundle for a RECOVER proof', async () => {
    const { userId } = await signUp(alice);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const res = await request(app).post('/api/auth/recover/bundle').send({ emailProof: await emailProof(alice, 'RECOVER') });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      recoveryBundle: stored.recoveryBundle,
      recoveryBundleNonce: stored.recoveryBundleNonce,
    });
  });

  it('rejects a proof issued for another purpose', async () => {
    await signUp(alice);

    const res = await request(app).post('/api/auth/recover/bundle').send({ emailProof: await emailProof(alice, 'VERIFY') });

    expect(res.status).toBe(400);
  });

  it('answers 404 for an email with no account', async () => {
    const res = await request(app)
      .post('/api/auth/recover/bundle')
      .send({ emailProof: await emailProof('nobody@example.com', 'RECOVER') });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/recover', () => {
  it('sets credentials signed by the recovered identity key and logs out everywhere', async () => {
    const { signingKey, cookie } = await signUp(alice);
    const update = signedCredentials(signingKey);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({ ...update, emailProof: await emailProof(alice, 'RECOVER') });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');

    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(res))).status).toBe(200);

    const login = await request(app).post('/api/auth/login').send({ email: alice, authKey: update.authKey });
    expect(login.status).toBe(200);
  });

  it('rejects an update signed by a different key', async () => {
    await signUp(alice);
    const update = signedCredentials(ed25519Keypair().signingKey);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({ ...update, emailProof: await emailProof(alice, 'RECOVER') });

    expect(res.status).toBe(403);
  });

  it('requires a RECOVER proof', async () => {
    const { signingKey } = await signUp(alice);
    const update = signedCredentials(signingKey);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({ ...update, emailProof: await emailProof(alice, 'VERIFY') });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/reset-identity', () => {
  it('issues new identity keys, retires the old ones, and logs out everywhere', async () => {
    const { userId, cookie } = await signUp(alice);
    const { ed25519Pub } = ed25519Keypair();
    const reset = {
      authKey: b64(32),
      kdf: KDF,
      x25519Pub: b64(32),
      ed25519Pub,
      keyBundle: b64(96),
      keyBundleNonce: b64(24),
      recoveryBundle: b64(96),
      recoveryBundleNonce: b64(24),
      emailProof: await emailProof(alice, 'RECOVER'),
    };

    const res = await request(app).post('/api/auth/reset-identity').send(reset);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(userId);

    const login = await request(app).post('/api/auth/login').send({ email: alice, authKey: reset.authKey });
    expect(login.body.data.keys).toEqual({ version: 2, x25519Pub: reset.x25519Pub, ed25519Pub });
    expect(login.body.data.keyBundle).toBe(reset.keyBundle);

    const keys = await request(app)
      .get(`/api/users/${userId}/keys`)
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(
      keys.body.data.map((key: { version: number; retiredAt: string | null }) => [key.version, key.retiredAt === null]),
    ).toEqual([
      [1, false],
      [2, true],
    ]);

    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });

  it('requires a RECOVER proof', async () => {
    await signUp(alice);

    const res = await request(app)
      .post('/api/auth/reset-identity')
      .send({ ...registrationBody(alice, b64(32)), emailProof: await emailProof(alice, 'VERIFY') });

    expect(res.status).toBe(400);
  });
});
