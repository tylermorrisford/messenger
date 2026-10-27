import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, toBase64 } from './keys';

export interface MessageContext {
  conversationId: string;
  senderId: string;
  epoch: number;
  /** null when the conversation default applies */
  ttlSeconds: number | null;
}

export interface EncryptedMessage {
  nonce: string;
  ciphertext: string;
  signature: string;
}

// must produce exactly what messageSigningInput builds in src/api/messages.ts
export function messageSigningInput(message: { conversationId: string; epoch: number; nonce: string; ciphertext: string }): string {
  return ['messenger/message/v1', message.conversationId, message.epoch, message.nonce, message.ciphertext].join('\n');
}

// binds the plaintext fields the server acts on, so it can't move a message to another sender, epoch, or expiry
function additionalData(context: MessageContext): string {
  return ['messenger/message-aad/v1', context.conversationId, context.senderId, context.epoch, context.ttlSeconds ?? ''].join('\n');
}

export async function encryptMessage(
  text: string,
  context: MessageContext,
  conversationKey: Uint8Array,
  ed25519Priv: Uint8Array,
): Promise<EncryptedMessage> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(text, additionalData(context), null, nonce, conversationKey);
  const encoded = { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
  const signature = sodium.crypto_sign_detached(messageSigningInput({ ...context, ...encoded }), ed25519Priv);

  return { ...encoded, signature: toBase64(signature) };
}

/** Throws when the signature isn't the sender's, the key is wrong, or the message or its context changed */
export async function decryptMessage(
  message: EncryptedMessage & MessageContext,
  conversationKey: Uint8Array,
  senderEd25519Pub: string,
): Promise<string> {
  await sodium.ready;

  if (!sodium.crypto_sign_verify_detached(fromBase64(message.signature), messageSigningInput(message), fromBase64(senderEd25519Pub))) {
    throw new Error('Message signature does not match the sender');
  }

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(message.ciphertext),
    additionalData(message),
    fromBase64(message.nonce),
    conversationKey,
  );

  return sodium.to_string(plaintext);
}
