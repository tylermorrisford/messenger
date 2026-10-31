import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { linkIdFor, normalizeLinkCode, openFromDevice, sealForDevice, signLinkClaim, startLink, verifyLinkingDevice } from './device-link';
import { fromBase64, generateIdentity } from './keys';

describe('startLink', () => {
  it('makes a 12-character code in groups of four and a hex link id derived from it', async () => {
    const { code, linkId, request } = await startLink();

    expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(linkId).toMatch(/^[0-9a-f]{64}$/);
    expect(request.linkId).toBe(linkId);
    expect(await linkIdFor(code.toUpperCase().replaceAll('-', ' '))).toBe(linkId);
    expect(fromBase64(request.ephemeralPub)).toHaveLength(32);
    expect(fromBase64(request.mac)).toHaveLength(32);
  });

  it('makes a different code and key each time', async () => {
    const [a, b] = await Promise.all([startLink(), startLink()]);

    expect(a.code).not.toBe(b.code);
    expect(a.request.ephemeralPub).not.toBe(b.request.ephemeralPub);
  });
});

describe('normalizeLinkCode', () => {
  it('ignores case, spacing, and separators', () => {
    expect(normalizeLinkCode(' ABCD-efgh 2345 ')).toBe('abcdefgh2345');
  });
});

describe('verifyLinkingDevice', () => {
  it('accepts the MAC the new device made with the same code', async () => {
    const { code, request } = await startLink();

    expect(await verifyLinkingDevice(code, request.ephemeralPub, request.mac)).toBe(true);
  });

  it('rejects a MAC made with another code and a swapped ephemeral key', async () => {
    const { code, request } = await startLink();
    const other = await startLink();

    expect(await verifyLinkingDevice(other.code, request.ephemeralPub, request.mac)).toBe(false);
    expect(await verifyLinkingDevice(code, other.request.ephemeralPub, request.mac)).toBe(false);
  });
});

describe('sealForDevice and openFromDevice', () => {
  it('delivers the identity to the device that knows the code and holds the ephemeral key', async () => {
    const keys = await generateIdentity();
    const { code, ephemeral, request } = await startLink();

    const sealed = await sealForDevice(keys, code, request.ephemeralPub);
    const opened = await openFromDevice(code, ephemeral, sealed);

    expect(opened).toEqual(keys);
  });

  it('refuses a bundle sealed by a device with a different code', async () => {
    const keys = await generateIdentity();
    const { code, ephemeral, request } = await startLink();

    const sealed = await sealForDevice(keys, 'zzzz-zzzz-zzzz', request.ephemeralPub);

    await expect(openFromDevice(code, ephemeral, sealed)).rejects.toThrow('did not come from a device that knows this code');
  });

  it('refuses a bundle sealed to another ephemeral key', async () => {
    const keys = await generateIdentity();
    const { code, ephemeral } = await startLink();
    const other = await startLink();

    const sealed = await sealForDevice(keys, code, other.request.ephemeralPub);

    await expect(openFromDevice(code, ephemeral, sealed)).rejects.toThrow();
  });
});

describe('signLinkClaim', () => {
  it('signs the versioned link id so the server can check it with the public key', async () => {
    const keys = await generateIdentity();
    const { linkId } = await startLink();

    const signature = signLinkClaim(linkId, keys.ed25519Priv);
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keys.ed25519Pub).toString('base64url') },
      format: 'jwk',
    });

    expect(verify(null, Buffer.from(`messenger/device-link/v1\n${linkId}`), publicKey, fromBase64(signature))).toBe(true);
  });
});
