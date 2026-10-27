import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';
import {
  addMember,
  auth,
  b64,
  ed25519Keypair,
  emailProof,
  lastEmailText,
  registrationBody,
  rotateKey,
  signUp,
  startConversation,
  wrappedKeyFor,
  type TestUser,
} from '../test/helpers.js';

let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await prisma.conversation.deleteMany();
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
});

afterAll(async () => {
  await prisma.$disconnect();
});

function getConversation(user: TestUser, id: string) {
  return request(app).get(`/api/conversations/${id}`).set(auth(user));
}

function getKeys(user: TestUser, id: string) {
  return request(app).get(`/api/conversations/${id}/keys`).set(auth(user));
}

describe('POST /api/conversations', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/conversations').send({});

    expect(res.status).toBe(401);
  });

  it('creates the conversation with the caller as owner and stores their wrapped key', async () => {
    const id = randomUUID();
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({
        id,
        title: 'Friends',
        key: wrappedKeyFor(alice.signingKey, { conversationId: id, epoch: 1, recipientUserId: alice.userId }),
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id,
      title: 'Friends',
      currentEpoch: 1,
      defaultTtlSeconds: 604800,
      needsRotation: false,
      createdById: alice.userId,
    });
    expect(res.body.data.members).toEqual([
      expect.objectContaining({ userId: alice.userId, role: 'OWNER', email: 'alice@example.com', name: 'Alice' }),
    ]);

    const keys = await getKeys(alice, id);
    expect(keys.body.data.epoch).toBe(1);
    expect(keys.body.data.mine).toEqual([
      expect.objectContaining({ epoch: 1, recipientKeyVersion: 1, distributorUserId: alice.userId, distributorKeyVersion: 1 }),
    ]);
    expect(keys.body.data.missing).toEqual([]);
  });

  it('rejects a self key signed by another identity', async () => {
    const id = randomUUID();
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({ id, key: wrappedKeyFor(bob.signingKey, { conversationId: id, epoch: 1, recipientUserId: alice.userId }) });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/conversations', () => {
  it('lists only the conversations the caller belongs to', async () => {
    const mine = await startConversation(alice, 'Mine');
    await startConversation(bob, 'Theirs');

    const res = await request(app).get('/api/conversations').set(auth(alice));

    expect(res.status).toBe(200);
    expect(res.body.data.map((conversation: { id: string }) => conversation.id)).toEqual([mine]);
  });

  it('hides a conversation from non-members', async () => {
    const id = await startConversation(alice);

    expect((await getConversation(bob, id)).status).toBe(404);
    expect((await getKeys(bob, id)).status).toBe(404);
  });
});

describe('POST /api/conversations/:id/members', () => {
  it('adds an existing user along with the current epoch key', async () => {
    const id = await startConversation(alice);

    const res = await addMember(alice, id, bob);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userId: bob.userId, role: 'MEMBER', email: 'bob@example.com' });

    const keys = await getKeys(bob, id);
    expect(keys.body.data.mine).toEqual([expect.objectContaining({ epoch: 1, distributorUserId: alice.userId })]);
  });

  it('refuses to add someone who is already a member', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    expect((await addMember(alice, id, bob)).status).toBe(409);
  });

  it('rejects a key signed with the wrong identity key', async () => {
    const id = await startConversation(alice);

    const res = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set(auth(alice))
      .send(wrappedKeyFor(bob.signingKey, { conversationId: id, epoch: 1, recipientUserId: bob.userId }));

    expect(res.status).toBe(403);
  });

  it('rejects a key wrapped for an outdated recipient key version', async () => {
    const id = await startConversation(alice);

    const res = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set(auth(alice))
      .send(wrappedKeyFor(alice.signingKey, { conversationId: id, epoch: 1, recipientUserId: bob.userId, recipientKeyVersion: 2 }));

    expect(res.status).toBe(409);
  });

  it('only lets members add members', async () => {
    const id = await startConversation(alice);
    const carol = await signUp('carol@example.com');

    expect((await addMember(bob, id, carol)).status).toBe(404);
  });
});

describe('POST /api/conversations/:id/invites', () => {
  it('joins the invitee on sign-up, then a member wraps the key for them', async () => {
    const id = await startConversation(alice);

    const invited = await request(app)
      .post(`/api/conversations/${id}/invites`)
      .set(auth(alice))
      .send({ email: 'carol@example.com' });
    expect(invited.status).toBe(201);

    const token = lastEmailText().match(/\/invite\?token=(\S+)/)?.[1];
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ ...registrationBody('carol@example.com', b64(32)), inviteToken: token });
    expect(registered.status).toBe(201);
    const carol = { userId: registered.body.data.user.id as string, accessToken: registered.body.data.accessToken as string };

    const listed = await request(app).get('/api/conversations').set(auth(carol));
    expect(listed.body.data.map((conversation: { id: string }) => conversation.id)).toEqual([id]);

    const seen = await getKeys(alice, id);
    expect(seen.body.data.missing).toEqual([
      expect.objectContaining({ userId: carol.userId, keyVersion: 1, x25519Pub: expect.any(String), ed25519Pub: expect.any(String) }),
    ]);

    const key = wrappedKeyFor(alice.signingKey, { conversationId: id, epoch: 1, recipientUserId: carol.userId });
    expect((await request(app).post(`/api/conversations/${id}/keys`).set(auth(alice)).send(key)).status).toBe(201);
    expect((await request(app).post(`/api/conversations/${id}/keys`).set(auth(alice)).send(key)).status).toBe(409);

    const theirs = await request(app).get(`/api/conversations/${id}/keys`).set(auth(carol));
    expect(theirs.body.data.mine).toEqual([expect.objectContaining({ epoch: 1, distributorUserId: alice.userId })]);
    expect((await getKeys(alice, id)).body.data.missing).toEqual([]);
  });

  it('only lets members invite', async () => {
    const id = await startConversation(alice);

    const res = await request(app)
      .post(`/api/conversations/${id}/invites`)
      .set(auth(bob))
      .send({ email: 'carol@example.com' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/conversations/:id/leave', () => {
  it('flags the conversation for rotation and hands ownership to the longest-standing member', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    expect((await request(app).post(`/api/conversations/${id}/leave`).set(auth(alice))).status).toBe(204);

    expect((await getConversation(alice, id)).status).toBe(404);

    const seen = await getConversation(bob, id);
    expect(seen.body.data.needsRotation).toBe(true);
    expect(seen.body.data.members).toEqual([expect.objectContaining({ userId: bob.userId, role: 'OWNER' })]);
  });
});

describe('POST /api/conversations/:id/rotate', () => {
  it('starts a new epoch for the remaining members', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    const res = await rotateKey(alice, id, 1, [alice, bob]);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ epoch: 2 });

    const keys = await getKeys(bob, id);
    expect(keys.body.data.epoch).toBe(2);
    expect(keys.body.data.mine.map((key: { epoch: number }) => key.epoch)).toEqual([1, 2]);
  });

  it('rejects a stale epoch', async () => {
    const id = await startConversation(alice);

    expect((await rotateKey(alice, id, 2, [alice])).status).toBe(409);
  });

  it('requires keys for exactly the remaining members', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    expect((await rotateKey(alice, id, 1, [alice])).status).toBe(400);
  });

  it('lets an owner remove a member', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    const res = await rotateKey(alice, id, 1, [alice], bob.userId);

    expect(res.status).toBe(200);
    expect((await getConversation(bob, id)).status).toBe(404);

    const seen = await getConversation(alice, id);
    expect(seen.body.data.currentEpoch).toBe(2);
    expect(seen.body.data.members.map((member: { userId: string }) => member.userId)).toEqual([alice.userId]);
  });

  it('only lets owners remove members', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);

    expect((await rotateKey(bob, id, 1, [bob], alice.userId)).status).toBe(403);
    expect((await rotateKey(alice, id, 1, [bob], alice.userId)).status).toBe(400);
  });

  it('clears the rotation flag after someone leaves', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);
    await request(app).post(`/api/conversations/${id}/leave`).set(auth(bob));

    expect((await rotateKey(alice, id, 1, [alice])).status).toBe(200);

    const seen = await getConversation(alice, id);
    expect(seen.body.data).toMatchObject({ currentEpoch: 2, needsRotation: false });
  });
});

describe('POST /api/auth/reset-identity', () => {
  it('leaves every conversation so the others re-key without the old identity', async () => {
    const id = await startConversation(alice);
    await addMember(alice, id, bob);
    const { ed25519Pub } = ed25519Keypair();

    const res = await request(app)
      .post('/api/auth/reset-identity')
      .send({ ...registrationBody('bob@example.com', b64(32)), ed25519Pub, emailProof: await emailProof('bob@example.com', 'RECOVER') });

    expect(res.status).toBe(200);

    const seen = await getConversation(alice, id);
    expect(seen.body.data.needsRotation).toBe(true);
    expect(seen.body.data.members.map((member: { userId: string }) => member.userId)).toEqual([alice.userId]);
  });
});

describe('GET /api/users?email=', () => {
  it('returns the current public keys for a known email', async () => {
    const res = await request(app).get('/api/users').query({ email: 'Bob@Example.com' }).set(auth(alice));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: bob.userId, email: 'bob@example.com', keys: { version: 1 } });
  });

  it('404s for an unknown email', async () => {
    const res = await request(app).get('/api/users').query({ email: 'nobody@example.com' }).set(auth(alice));

    expect(res.status).toBe(404);
  });

  it('rejects an invalid email', async () => {
    const res = await request(app).get('/api/users').query({ email: 'nope' }).set(auth(alice));

    expect(res.status).toBe(400);
  });
});
