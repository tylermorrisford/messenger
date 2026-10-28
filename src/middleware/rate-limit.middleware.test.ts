import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';
import { auth, b64, signUp } from '../test/helpers.js';

beforeEach(async () => {
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rate limits', () => {
  it('blocks the 11th login attempt from one address', async () => {
    const body = { email: 'nobody@example.com', authKey: b64(32) };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request(app).post('/api/auth/login').send(body)).status).toBe(401);
    }

    const res = await request(app).post('/api/auth/login').send(body);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, error: 'Too many attempts, try again later' });
    expect(res.get('Retry-After')).toBeDefined();
  });

  it('sends at most 5 email codes per address', async () => {
    const body = { email: 'alice@example.com', purpose: 'VERIFY' };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(app).post('/api/auth/email-code').send(body)).status).toBe(200);
    }

    expect((await request(app).post('/api/auth/email-code').send(body)).status).toBe(429);
  });

  it('counts invites per user, not per address', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    for (let n = 0; n < 20; n += 1) {
      const res = await request(app).post('/api/invites').set(auth(alice)).send({ email: `friend${n}@example.com` });

      expect(res.status).toBe(201);
    }

    expect((await request(app).post('/api/invites').set(auth(alice)).send({ email: 'late@example.com' })).status).toBe(429);
    expect((await request(app).post('/api/invites').set(auth(bob)).send({ email: 'late@example.com' })).status).toBe(201);
  });
});
