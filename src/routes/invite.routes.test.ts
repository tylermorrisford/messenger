import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { issueInvite } from '../api/invites.js';
import { b64, lastEmailText, registrationBody, signUp } from '../test/helpers.js';

let alice: Awaited<ReturnType<typeof signUp>>;

beforeEach(async () => {
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
  alice = await signUp('alice@example.com');
  env.REGISTRATION_MODE = 'invite';
});

afterEach(() => {
  env.REGISTRATION_MODE = 'open';
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function inviteBob(): Promise<string> {
  const res = await request(app)
    .post('/api/invites')
    .set('Authorization', `Bearer ${alice.accessToken}`)
    .send({ email: 'Bob@Example.com' });

  expect(res.status).toBe(201);

  const token = lastEmailText().match(/\/invite\?token=(\S+)/)?.[1];

  if (!token) {
    throw new Error('Invite email had no token');
  }

  return token;
}

describe('POST /api/invites', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/invites').send({ email: 'bob@example.com' });

    expect(res.status).toBe(401);
  });

  it('emails a sign-up link on the app origin', async () => {
    await inviteBob();

    expect(lastEmailText()).toContain(`${env.APP_ORIGIN}/invite?token=`);
  });

  it('refuses to invite an email that already has an account', async () => {
    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ email: 'ALICE@example.com' });

    expect(res.status).toBe(409);
  });
});

describe('invite-only registration', () => {
  it('refuses to register without an invite', async () => {
    const res = await request(app).post('/api/auth/register').send(registrationBody('bob@example.com', b64(32)));

    expect(res.status).toBe(403);
  });

  it('shows the invite, lets the invitee register once, then forgets it', async () => {
    const token = await inviteBob();

    const shown = await request(app).get(`/api/invites/${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data.email).toBe('bob@example.com');

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('bob@example.com', b64(32)), inviteToken: token });
    expect(registered.status).toBe(201);
    expect(registered.body.data.user.email).toBe('bob@example.com');

    expect((await request(app).get(`/api/invites/${token}`)).status).toBe(404);

    const again = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('bob@example.com', b64(32)), inviteToken: token });
    expect(again.status).toBe(400);
  });

  it('rejects an invite used with a different email', async () => {
    const token = await inviteBob();

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('carol@example.com', b64(32)), inviteToken: token });

    expect(res.status).toBe(400);
  });

  it('rejects an expired invite', async () => {
    const token = await inviteBob();
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(`/api/invites/${token}`)).status).toBe(404);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('bob@example.com', b64(32)), inviteToken: token });
    expect(res.status).toBe(400);
  });
});

describe('invites issued without an inviter', () => {
  it('let the invitee register', async () => {
    const { link } = await issueInvite('bob@example.com', null);
    const token = new URL(link).searchParams.get('token');

    const shown = await request(app).get(`/api/invites/${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data.email).toBe('bob@example.com');

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('bob@example.com', b64(32)), inviteToken: token });
    expect(registered.status).toBe(201);
  });
});
