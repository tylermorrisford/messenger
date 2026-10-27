import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, toBase64 } from './keys';

export interface Recipient {
  userId: string;
  keyVersion: number;
  /** base64, as served by the API */
  x25519Pub: string;
}

export interface WrappedKey {
  recipientUserId: string;
  recipientKeyVersion: number;
  wrappedKey: string;
  signature: string;
}

export async function generateConversationKey(): Promise<Uint8Array> {
  await sodium.ready;

  return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

// must produce exactly what conversationKeySigningInput builds in src/api/conversations.ts
export function conversationKeySigningInput(
  key: Omit<WrappedKey, 'signature'> & { conversationId: string; epoch: number },
): string {
  return [
    'messenger/conversation-key/v1',
    key.conversationId,
    key.epoch,
    key.recipientUserId,
    key.recipientKeyVersion,
    key.wrappedKey,
  ].join('\n');
}

/** Seals the epoch key to one member and signs the row so everyone can check who wrapped it */
export async function wrapConversationKey(
  key: Uint8Array,
  recipient: Recipient,
  conversationId: string,
  epoch: number,
  ed25519Priv: Uint8Array,
): Promise<WrappedKey> {
  await sodium.ready;
  const row = {
    recipientUserId: recipient.userId,
    recipientKeyVersion: recipient.keyVersion,
    wrappedKey: toBase64(sodium.crypto_box_seal(key, fromBase64(recipient.x25519Pub))),
  };
  const signature = sodium.crypto_sign_detached(conversationKeySigningInput({ ...row, conversationId, epoch }), ed25519Priv);

  return { ...row, signature: toBase64(signature) };
}

/** The server checks this too, but the client must not trust a key the distributor didn't sign */
export async function verifyWrappedKey(
  row: WrappedKey & { conversationId: string; epoch: number },
  distributorEd25519Pub: string,
): Promise<boolean> {
  await sodium.ready;

  return sodium.crypto_sign_verify_detached(
    fromBase64(row.signature),
    conversationKeySigningInput(row),
    fromBase64(distributorEd25519Pub),
  );
}

/** Throws when the key was sealed to a different identity or was tampered with */
export async function unwrapConversationKey(
  wrappedKey: string,
  identity: { x25519Pub: Uint8Array; x25519Priv: Uint8Array },
): Promise<Uint8Array> {
  await sodium.ready;

  return sodium.crypto_box_seal_open(fromBase64(wrappedKey), identity.x25519Pub, identity.x25519Priv);
}
