import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';
import { b64, emailProof, KDF, lastEmailText, refreshCookie, registrationBody, signUp } from '../test/helpers.js';

const alice = 'alice@example.com';

beforeEach(async () => {
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('reports success when the database answers', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/auth/params', () => {
  it('returns the defaults for an unknown email', async () => {
    const res = await request(app).get('/api/auth/params').query({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.kdf).toEqual(KDF);
  });

  it('returns the parameters the account was created with', async () => {
    const kdf = { ...KDF, memLimit: 32 * 1024 * 1024 };
    await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody(alice, b64(32)), kdf, emailProof: await emailProof(alice) });

    const res = await request(app).get('/api/auth/params').query({ email: 'ALICE@example.com' });

    expect(res.body.data.kdf).toEqual(kdf);
  });

  it('rejects a missing email', async () => {
    const res = await request(app).get('/api/auth/params');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/register (open registration)', () => {
  it('creates the user, normalizes the email, and starts a session', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('  Alice@Example.COM ', b64(32)), emailProof: await emailProof(alice) });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(alice);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(refreshCookie(res)).toMatch(/^refresh=/);
    expect(res.get('Set-Cookie')?.[0]).toContain('HttpOnly');
  });

  it('requires a verified email', async () => {
    const res = await request(app).post('/api/auth/register').send(registrationBody(alice, b64(32)));

    expect(res.status).toBe(400);
  });

  it('rejects a proof issued for a different email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody(alice, b64(32)), emailProof: await emailProof('mallory@example.com') });

    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await signUp(alice);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('ALICE@example.com', b64(32)), emailProof: await emailProof(alice) });

    expect(res.status).toBe(409);
  });

  it('rejects malformed key material and names the fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody(alice, b64(16)), x25519Pub: b64(16) });

    expect(res.status).toBe(400);
    expect(res.body.issues.map((issue: { path: string }) => issue.path)).toEqual(['authKey', 'x25519Pub']);
  });
});

describe('POST /api/auth/email-code and /verify', () => {
  it('emails a six digit code and trades it for a proof', async () => {
    await request(app).post('/api/auth/email-code').send({ email: alice, purpose: 'VERIFY' });
    const code = lastEmailText().match(/code is (\d{6})/)?.[1];

    const res = await request(app).post('/api/auth/verify').send({ email: alice, purpose: 'VERIFY', code });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.proof).toBe('string');
  });

  it('rejects a wrong code and locks the code after five tries', async () => {
    await request(app).post('/api/auth/email-code').send({ email: alice, purpose: 'VERIFY' });
    const code = lastEmailText().match(/code is (\d{6})/)![1];
    const wrong = code === '000000' ? '000001' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app).post('/api/auth/verify').send({ email: alice, purpose: 'VERIFY', code: wrong });
      expect(res.status).toBe(400);
    }

    const res = await request(app).post('/api/auth/verify').send({ email: alice, purpose: 'VERIFY', code });

    expect(res.status).toBe(400);
  });

  it('only accepts a code once', async () => {
    await request(app).post('/api/auth/email-code').send({ email: alice, purpose: 'VERIFY' });
    const code = lastEmailText().match(/code is (\d{6})/)?.[1];

    await request(app).post('/api/auth/verify').send({ email: alice, purpose: 'VERIFY', code });
    const res = await request(app).post('/api/auth/verify').send({ email: alice, purpose: 'VERIFY', code });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns the key bundle, KDF parameters, and current public keys', async () => {
    const { authKey } = await signUp(alice);

    const res = await request(app).post('/api/auth/login').send({ email: 'ALICE@EXAMPLE.COM', authKey });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.kdf).toEqual(KDF);
    expect(typeof res.body.data.keyBundle).toBe('string');
    expect(res.body.data.keys.version).toBe(1);
    expect(refreshCookie(res)).toMatch(/^refresh=/);
  });

  it('rejects a wrong auth key', async () => {
    await signUp(alice);

    const res = await request(app).post('/api/auth/login').send({ email: alice, authKey: b64(32) });

    expect(res.status).toBe(401);
  });

  it('rejects an unknown email the same way', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: alice, authKey: b64(32) });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the cookie and issues a usable access token', async () => {
    const { cookie } = await signUp(alice);

    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).not.toBe(cookie);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('accepts the previous token during the grace window without rotating again', async () => {
    const { cookie } = await signUp(alice);
    const first = await request(app).post('/api/auth/refresh').set('Cookie', cookie);

    const second = await request(app).post('/api/auth/refresh').set('Cookie', cookie);

    expect(second.status).toBe(200);
    expect(second.get('Set-Cookie')).toBeUndefined();

    const third = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(first));
    expect(third.status).toBe(200);
  });

  it('revokes the whole session when an old token is replayed after the grace window', async () => {
    const { cookie } = await signUp(alice);
    const first = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    await prisma.session.updateMany({ data: { rotatedAt: new Date(Date.now() - 60_000) } });

    const replay = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    const current = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(first));
    expect(current.status).toBe(401);
  });

  it('rejects a missing or unknown cookie', async () => {
    expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', 'refresh=nope')).status).toBe(401);
  });
});

describe('DELETE /api/auth/refresh', () => {
  it('revokes the session and clears the cookie', async () => {
    const { cookie } = await signUp(alice);

    const res = await request(app).delete('/api/auth/refresh').set('Cookie', cookie);

    expect(res.status).toBe(204);
    expect(res.get('Set-Cookie')?.[0]).toMatch(/^refresh=;/);

    const after = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid access token', async () => {
    const { accessToken } = await signUp(alice);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(alice);
  });

  it('rejects a missing token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });

  it('rejects a token minted for another purpose', async () => {
    const proof = await emailProof(alice);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${proof}`);

    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/:id/keys', () => {
  it('lists the public keys of a user', async () => {
    const { accessToken, userId } = await signUp(alice);

    const res = await request(app).get(`/api/users/${userId}/keys`).set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ version: 1, retiredAt: null });
    expect(res.body.data[0].x25519Pub).toHaveLength(44);
  });

  it('returns 404 for an unknown user', async () => {
    const { accessToken } = await signUp(alice);

    const res = await request(app).get('/api/users/nobody/keys').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const { userId } = await signUp(alice);

    const res = await request(app).get(`/api/users/${userId}/keys`);

    expect(res.status).toBe(401);
  });
});
