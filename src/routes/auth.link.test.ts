import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../server.js';
import { deviceLinkSigningInput, LINK_TTL_MS, sweepDeviceLinks } from '../api/device-links.js';
import { prisma } from '../lib/prisma.js';
import { auth, b64, ed25519Keypair, refreshCookie, signMessage, signUp, type TestUser } from '../test/helpers.js';

let alice: TestUser;

beforeEach(async () => {
  await prisma.deviceLink.deleteMany();
  await prisma.user.deleteMany();
  await prisma.emailCode.deleteMany();
  alice = await signUp('alice@example.com');
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newLinkId = () => createHash('sha256').update(randomBytes(8)).digest('hex');

async function startLink(linkId = newLinkId()) {
  const res = await request(app).post('/api/auth/link').send({ linkId, ephemeralPub: b64(32), mac: b64(32) });

  expect(res.status).toBe(201);

  return linkId;
}

function approve(user: TestUser, linkId: string) {
  return request(app).post(`/api/auth/link/${linkId}/approve`).set(auth(user)).send({ sealedBundle: b64(144), bundleMac: b64(32) });
}

function claim(linkId: string, signature: string) {
  return request(app).post(`/api/auth/link/${linkId}/claim`).send({ signature });
}

describe('POST /api/auth/link and GET /api/auth/link/:id', () => {
  it('starts a link that expires in five minutes and polls as pending', async () => {
    const linkId = newLinkId();
    const before = Date.now();

    const started = await request(app).post('/api/auth/link').send({ linkId, ephemeralPub: b64(32), mac: b64(32) });
    const poll = await request(app).get(`/api/auth/link/${linkId}`);

    expect(started.status).toBe(201);
    expect(new Date(started.body.data.expiresAt).getTime()).toBeGreaterThanOrEqual(before + LINK_TTL_MS);
    expect(poll.status).toBe(200);
    expect(poll.body.data).toEqual({ approved: false });
  });

  it('rejects a link id that is not 64 hex characters', async () => {
    const res = await request(app).post('/api/auth/link').send({ linkId: b64(32), ephemeralPub: b64(32), mac: b64(32) });
    const poll = await request(app).get('/api/auth/link/not-hex');

    expect(res.status).toBe(400);
    expect(poll.status).toBe(400);
  });

  it('answers 404 for an unknown or expired link', async () => {
    const linkId = await startLink();
    await prisma.deviceLink.update({ where: { id: linkId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(`/api/auth/link/${newLinkId()}`)).status).toBe(404);
    expect((await request(app).get(`/api/auth/link/${linkId}`)).status).toBe(404);
  });
});

describe('GET /api/auth/link/:id/device and POST /api/auth/link/:id/approve', () => {
  it('shows the signed-in device the ephemeral key and MAC, then stores the sealed bundle for the poller', async () => {
    const linkId = newLinkId();
    const ephemeralPub = b64(32);
    const mac = b64(32);
    await request(app).post('/api/auth/link').send({ linkId, ephemeralPub, mac });

    const device = await request(app).get(`/api/auth/link/${linkId}/device`).set(auth(alice));
    expect(device.status).toBe(200);
    expect(device.body.data).toEqual({ ephemeralPub, mac });

    const sealedBundle = b64(144);
    const bundleMac = b64(32);
    const approved = await request(app).post(`/api/auth/link/${linkId}/approve`).set(auth(alice)).send({ sealedBundle, bundleMac });
    expect(approved.status).toBe(204);

    const poll = await request(app).get(`/api/auth/link/${linkId}`);
    expect(poll.body.data).toEqual({ approved: true, sealedBundle, bundleMac });
  });

  it('requires a signed-in device', async () => {
    const linkId = await startLink();

    expect((await request(app).get(`/api/auth/link/${linkId}/device`)).status).toBe(401);
    expect((await request(app).post(`/api/auth/link/${linkId}/approve`).send({ sealedBundle: b64(144), bundleMac: b64(32) })).status).toBe(401);
  });

  it('approves a link only once', async () => {
    const linkId = await startLink();
    await approve(alice, linkId);

    expect((await approve(alice, linkId)).status).toBe(409);
    expect((await request(app).get(`/api/auth/link/${linkId}/device`).set(auth(alice))).status).toBe(409);
  });

  it('answers 404 for an unknown link', async () => {
    expect((await approve(alice, newLinkId())).status).toBe(404);
  });
});

describe('POST /api/auth/link/:id/claim', () => {
  it('starts a session for the approving account when the signature is by its identity key', async () => {
    const linkId = await startLink();
    await approve(alice, linkId);

    const res = await claim(linkId, signMessage(alice.signingKey, deviceLinkSigningInput(linkId)));

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(alice.userId);
    expect(res.body.data.keys.version).toBe(1);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.refreshToken).toBeUndefined();

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.body.data.email).toBe('alice@example.com');
    expect((await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(res))).status).toBe(200);
  });

  it('consumes the link', async () => {
    const linkId = await startLink();
    await approve(alice, linkId);
    const signature = signMessage(alice.signingKey, deviceLinkSigningInput(linkId));
    await claim(linkId, signature);

    expect((await claim(linkId, signature)).status).toBe(404);
    expect((await request(app).get(`/api/auth/link/${linkId}`)).status).toBe(404);
  });

  it('rejects a signature by another key', async () => {
    const linkId = await startLink();
    await approve(alice, linkId);

    const res = await claim(linkId, signMessage(ed25519Keypair().signingKey, deviceLinkSigningInput(linkId)));

    expect(res.status).toBe(403);
    expect((await request(app).get(`/api/auth/link/${linkId}`)).body.data.approved).toBe(true);
  });

  it('rejects a signature over a different link id', async () => {
    const linkId = await startLink();
    await approve(alice, linkId);

    const res = await claim(linkId, signMessage(alice.signingKey, deviceLinkSigningInput(newLinkId())));

    expect(res.status).toBe(403);
  });

  it('refuses before a device has approved', async () => {
    const linkId = await startLink();

    const res = await claim(linkId, signMessage(alice.signingKey, deviceLinkSigningInput(linkId)));

    expect(res.status).toBe(409);
  });
});

describe('sweepDeviceLinks', () => {
  it('deletes expired links and keeps live ones', async () => {
    const expired = await startLink();
    const live = await startLink();
    await prisma.deviceLink.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await sweepDeviceLinks()).toBe(1);
    expect(await prisma.deviceLink.findMany({ select: { id: true } })).toEqual([{ id: live }]);
  });
});
