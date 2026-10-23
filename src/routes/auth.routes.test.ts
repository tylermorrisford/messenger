import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';

const alice = { email: '  Alice@Example.COM ', password: 'hunter22', name: 'Alice' };

beforeEach(async () => {
  await prisma.user.deleteMany();
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

describe('POST /api/auth/register', () => {
  it('creates the user with a normalized email and returns a token', async () => {
    const res = await request(app).post('/api/auth/register').send(alice);

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(typeof res.body.data.token).toBe('string');
  });

  it('rejects a duplicate email regardless of case', async () => {
    await request(app).post('/api/auth/register').send(alice);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...alice, email: 'ALICE@example.com' });

    expect(res.status).toBe(400);
  });

  it('rejects an invalid body and names the failing fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.issues.map((issue: { path: string }) => issue.path)).toEqual(['email', 'password']);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(alice);
  });

  it('accepts the email in any case', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@EXAMPLE.COM', password: alice.password });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
  });

  it('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: alice.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const registered = await request(app).post('/api/auth/register').send(alice);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${registered.body.data.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('alice@example.com');
  });

  it('rejects a missing token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });
});
