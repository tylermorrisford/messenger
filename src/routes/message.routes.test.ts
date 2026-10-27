import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { prisma } from '../lib/prisma.js';
import { sweepExpired } from '../api/messages.js';
import { addMember, auth, messageBody, rotateKey, signUp, startConversation, type TestUser } from '../test/helpers.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let alice: TestUser;
let bob: TestUser;
let id: string;

beforeEach(async () => {
  await prisma.conversation.deleteMany();
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
  id = await startConversation(alice);
  await addMember(alice, id, bob);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function send(user: TestUser, body: ReturnType<typeof messageBody>) {
  return request(app).post(`/api/conversations/${id}/messages`).set(auth(user)).send(body);
}

function list(user: TestUser, query: { after?: number; limit?: number } = {}) {
  return request(app).get(`/api/conversations/${id}/messages`).query(query).set(auth(user));
}

function ttlMs(message: { createdAt: string; expiresAt: string }): number {
  return Date.parse(message.expiresAt) - Date.parse(message.createdAt);
}

describe('POST /api/conversations/:id/messages', () => {
  it('stores the ciphertext with the conversation default expiry', async () => {
    const body = messageBody(alice.signingKey, id);

    const res = await send(alice, body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      conversationId: id,
      senderId: alice.userId,
      senderKeyVersion: 1,
      epoch: 1,
      ttlSeconds: null,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      signature: body.signature,
    });
    expect(typeof res.body.data.seq).toBe('number');
    expect(ttlMs(res.body.data)).toBe(WEEK_MS);
  });

  it('honors a per-message ttl', async () => {
    const res = await send(alice, messageBody(alice.signingKey, id, { ttlSeconds: 60 }));

    expect(res.status).toBe(201);
    expect(res.body.data.ttlSeconds).toBe(60);
    expect(ttlMs(res.body.data)).toBe(60_000);
  });

  it('rejects non-members', async () => {
    const carol = await signUp('carol@example.com');

    expect((await send(carol, messageBody(carol.signingKey, id))).status).toBe(404);
  });

  it('rejects a stale epoch', async () => {
    expect((await send(alice, messageBody(alice.signingKey, id, { epoch: 2 }))).status).toBe(409);
  });

  it('rejects a signature from another identity', async () => {
    expect((await send(alice, messageBody(bob.signingKey, id))).status).toBe(403);
  });

  it('rejects a signature over a different ciphertext', async () => {
    const body = messageBody(alice.signingKey, id);

    expect((await send(alice, { ...body, ciphertext: messageBody(alice.signingKey, id).ciphertext })).status).toBe(403);
  });

  it('refuses to send until the key is rotated after someone leaves', async () => {
    await request(app).post(`/api/conversations/${id}/leave`).set(auth(bob));

    expect((await send(alice, messageBody(alice.signingKey, id))).status).toBe(409);

    await rotateKey(alice, id, 1, [alice]);

    expect((await send(alice, messageBody(alice.signingKey, id))).status).toBe(409);
    expect((await send(alice, messageBody(alice.signingKey, id, { epoch: 2 }))).status).toBe(201);
  });

  it('refuses a removed member', async () => {
    await rotateKey(alice, id, 1, [alice], bob.userId);

    expect((await send(bob, messageBody(bob.signingKey, id, { epoch: 2 }))).status).toBe(404);
  });
});

describe('GET /api/conversations/:id/messages', () => {
  it('pages forward from a sequence number, oldest first', async () => {
    const first = (await send(alice, messageBody(alice.signingKey, id))).body.data;
    const second = (await send(bob, messageBody(bob.signingKey, id))).body.data;
    const third = (await send(alice, messageBody(alice.signingKey, id))).body.data;

    const all = await list(bob);
    expect(all.status).toBe(200);
    expect(all.body.data.map((message: { id: string }) => message.id)).toEqual([first.id, second.id, third.id]);

    const page = await list(bob, { after: first.seq, limit: 1 });
    expect(page.body.data.map((message: { id: string }) => message.id)).toEqual([second.id]);
  });

  it('hides expired messages', async () => {
    const expired = (await send(alice, messageBody(alice.signingKey, id))).body.data;
    const kept = (await send(alice, messageBody(alice.signingKey, id))).body.data;
    await prisma.message.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await list(alice);

    expect(res.body.data.map((message: { id: string }) => message.id)).toEqual([kept.id]);
  });

  it('rejects non-members', async () => {
    const carol = await signUp('carol@example.com');

    expect((await list(carol)).status).toBe(404);
  });

  it('rejects a bad cursor', async () => {
    expect((await list(alice, { after: -1 })).status).toBe(400);
  });
});

describe('sweepExpired', () => {
  it('deletes only the expired rows', async () => {
    const expired = (await send(alice, messageBody(alice.signingKey, id))).body.data;
    const kept = (await send(bob, messageBody(bob.signingKey, id))).body.data;
    await prisma.message.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await sweepExpired()).toBe(1);

    const left = await prisma.message.findMany({ select: { id: true } });
    expect(left.map((message) => message.id)).toEqual([kept.id]);
  });
});
