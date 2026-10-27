import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { env } from '../lib/env.js';
import { close } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';
import { addMember, auth, messageBody, rotateKey, signUp, startConversation, type TestUser } from '../test/helpers.js';

interface Stream {
  next: () => Promise<{ event: string; data: string } | null>;
  abort: () => void;
}

let server: Server;
let baseUrl: string;
let alice: TestUser;
let bob: TestUser;
let id: string;
const streams: Stream[] = [];

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await prisma.conversation.deleteMany();
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
  id = await startConversation(alice);
  await addMember(alice, id, bob);
  streams.splice(0).forEach((stream) => stream.abort());
});

afterAll(async () => {
  streams.forEach((stream) => stream.abort());
  await close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

/** Resolves once the response headers are in, which the server only sends after LISTEN is in place */
async function openStream(accessToken: string): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const next = async () => {
    for (;;) {
      const separator = buffer.indexOf('\n\n');
      if (separator !== -1) {
        const lines = buffer.slice(0, separator).split('\n');
        buffer = buffer.slice(separator + 2);
        const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
        if (event) {
          return { event, data: lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trim()).join('\n') };
        }
        continue;
      }

      const { value, done } = await reader.read();
      if (done) {
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const stream = {
    next: () =>
      Promise.race([next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No event within 3s')), 3000))]),
    abort: () => controller.abort(),
  };
  streams.push(stream);

  return stream;
}

function send(user: TestUser, conversationId: string) {
  return request(app).post(`/api/conversations/${conversationId}/messages`).set(auth(user)).send(messageBody(user.signingKey, conversationId));
}

describe('GET /api/events', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/events')).status).toBe(401);
  });

  it('pushes new messages to the other members', async () => {
    const stream = await openStream(bob.accessToken);

    const sent = (await send(alice, id)).body.data;

    const received = await stream.next();
    expect(received?.event).toBe('message');
    expect(JSON.parse(received!.data)).toEqual(sent);
  });

  it('skips conversations the listener is not in', async () => {
    const carol = await signUp('carol@example.com');
    const carolsOwn = await startConversation(carol);
    const stream = await openStream(carol.accessToken);

    await send(alice, id);
    const sent = (await send(carol, carolsOwn)).body.data;

    expect(JSON.parse((await stream.next())!.data).id).toBe(sent.id);
  });

  it('announces conversation changes', async () => {
    const stream = await openStream(bob.accessToken);

    await request(app).patch(`/api/conversations/${id}`).set(auth(alice)).send({ defaultTtlSeconds: null });

    expect(await stream.next()).toEqual({ event: 'conversation', data: JSON.stringify({ conversationId: id, reason: 'settings' }) });
  });

  it('still tells a member who was just removed', async () => {
    const stream = await openStream(bob.accessToken);

    await rotateKey(alice, id, 1, [alice], bob.userId);

    expect(JSON.parse((await stream.next())!.data)).toEqual({ conversationId: id, reason: 'rotated' });
  });

  it('ends the stream when the access token expires', async () => {
    const shortLived = jwt.sign({ sid: alice.userId }, env.JWT_SECRET, { subject: alice.userId, audience: 'access', expiresIn: '1s' });
    const stream = await openStream(shortLived);

    expect(await stream.next()).toBeNull();
  });
});
