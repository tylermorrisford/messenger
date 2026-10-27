import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateIdentity, toBase64 } from './keys';
import { generateConversationKey, unwrapConversationKey, verifyWrappedKey, wrapConversationKey } from './conversation';

const CONVERSATION_ID = '019a4b2e-7c3d-7e5f-8a9b-0c1d2e3f4a5b';

async function member() {
  const keys = await generateIdentity();

  return { keys, recipient: { userId: crypto.randomUUID(), keyVersion: 1, x25519Pub: toBase64(keys.x25519Pub) } };
}

describe('conversation key', () => {
  it('is 32 random bytes', async () => {
    const a = await generateConversationKey();
    const b = await generateConversationKey();

    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });

  it('round-trips through a sealed box only for the recipient', async () => {
    const alice = await member();
    const bob = await member();
    const carol = await member();
    const key = await generateConversationKey();

    const wrapped = await wrapConversationKey(key, bob.recipient, CONVERSATION_ID, 1, alice.keys.ed25519Priv);

    expect(wrapped).toMatchObject({ recipientUserId: bob.recipient.userId, recipientKeyVersion: 1 });
    expect(wrapped.wrappedKey).toHaveLength(108);
    expect(await unwrapConversationKey(wrapped.wrappedKey, bob.keys)).toEqual(key);
    await expect(unwrapConversationKey(wrapped.wrappedKey, carol.keys)).rejects.toThrow();
  });

  it('signs the row so only the distributor could have wrapped it', async () => {
    const alice = await member();
    const bob = await member();
    const key = await generateConversationKey();

    const wrapped = await wrapConversationKey(key, bob.recipient, CONVERSATION_ID, 3, alice.keys.ed25519Priv);
    const row = { ...wrapped, conversationId: CONVERSATION_ID, epoch: 3 };

    expect(await verifyWrappedKey(row, toBase64(alice.keys.ed25519Pub))).toBe(true);
    expect(await verifyWrappedKey(row, toBase64(bob.keys.ed25519Pub))).toBe(false);
    expect(await verifyWrappedKey({ ...row, epoch: 4 }, toBase64(alice.keys.ed25519Pub))).toBe(false);
    expect(await verifyWrappedKey({ ...row, recipientKeyVersion: 2 }, toBase64(alice.keys.ed25519Pub))).toBe(false);
  });

  it('verifies with Node crypto the way the server does', async () => {
    const alice = await member();
    const bob = await member();

    const wrapped = await wrapConversationKey(await generateConversationKey(), bob.recipient, CONVERSATION_ID, 1, alice.keys.ed25519Priv);

    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(alice.keys.ed25519Pub).toString('base64url') },
      format: 'jwk',
    });
    const message = ['messenger/conversation-key/v1', CONVERSATION_ID, 1, bob.recipient.userId, 1, wrapped.wrappedKey].join('\n');

    expect(wrapped.signature).toHaveLength(88);
    expect(verify(null, Buffer.from(message), publicKey, Buffer.from(wrapped.signature, 'base64'))).toBe(true);
  });
});
