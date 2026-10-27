import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateConversationKey } from './conversation';
import { fromBase64, generateIdentity, toBase64 } from './keys';
import { decryptMessage, encryptMessage, type MessageContext } from './message';

const context: MessageContext = {
  conversationId: '019a4b2e-7c3d-7e5f-8a9b-0c1d2e3f4a5b',
  senderId: '019a4b2e-0000-7e5f-8a9b-0c1d2e3f4a5b',
  epoch: 2,
  ttlSeconds: null,
};

async function setup() {
  const alice = await generateIdentity();
  const key = await generateConversationKey();
  const encrypted = await encryptMessage('hello, bob 👋', context, key, alice.ed25519Priv);

  return { alice, key, message: { ...encrypted, ...context }, alicePub: toBase64(alice.ed25519Pub) };
}

describe('message encryption', () => {
  it('round-trips with the sender key and the epoch key', async () => {
    const { key, message, alicePub } = await setup();

    expect(message.nonce).toHaveLength(32);
    expect(message.signature).toHaveLength(88);
    expect(await decryptMessage(message, key, alicePub)).toBe('hello, bob 👋');
  });

  it('uses a fresh nonce for every message', async () => {
    const { alice, key, message } = await setup();

    const again = await encryptMessage('hello, bob 👋', context, key, alice.ed25519Priv);

    expect(again.nonce).not.toBe(message.nonce);
    expect(again.ciphertext).not.toBe(message.ciphertext);
  });

  it('rejects a flipped ciphertext byte', async () => {
    const { key, message, alicePub } = await setup();
    const bytes = fromBase64(message.ciphertext);
    bytes[3] ^= 1;

    await expect(decryptMessage({ ...message, ciphertext: toBase64(bytes) }, key, alicePub)).rejects.toThrow();
  });

  it('rejects a message moved to another sender, epoch, or expiry', async () => {
    const { key, message, alicePub } = await setup();

    await expect(decryptMessage({ ...message, senderId: context.conversationId }, key, alicePub)).rejects.toThrow();
    await expect(decryptMessage({ ...message, epoch: 3 }, key, alicePub)).rejects.toThrow();
    await expect(decryptMessage({ ...message, ttlSeconds: 60 }, key, alicePub)).rejects.toThrow();
  });

  it('rejects the wrong epoch key', async () => {
    const { message, alicePub } = await setup();

    await expect(decryptMessage(message, await generateConversationKey(), alicePub)).rejects.toThrow();
  });

  it('rejects a signature from another identity', async () => {
    const { key, message } = await setup();
    const bob = await generateIdentity();

    await expect(decryptMessage(message, key, toBase64(bob.ed25519Pub))).rejects.toThrow(/signature/);
  });

  it('verifies with Node crypto the way the server does', async () => {
    const { alice, message } = await setup();

    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(alice.ed25519Pub).toString('base64url') },
      format: 'jwk',
    });
    const input = ['messenger/message/v1', context.conversationId, context.epoch, message.nonce, message.ciphertext].join('\n');

    expect(verify(null, Buffer.from(input), publicKey, Buffer.from(message.signature, 'base64'))).toBe(true);
  });
});
