import sodium from 'libsodium-wrappers-sumo';
import type { KdfParams } from './kdf';

export interface IdentityKeys {
  x25519Pub: Uint8Array;
  x25519Priv: Uint8Array;
  ed25519Pub: Uint8Array;
  ed25519Priv: Uint8Array;
}

/** Both fields base64, as stored on the server */
export interface SealedBundle {
  bundle: string;
  nonce: string;
}

export interface CredentialUpdate {
  authKey: string;
  kdf: KdfParams;
  keyBundle: string;
  keyBundleNonce: string;
}

export const toBase64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

export const fromBase64 = (text: string): Uint8Array => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

export async function generateIdentity(): Promise<IdentityKeys> {
  await sodium.ready;
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();

  return { x25519Pub: box.publicKey, x25519Priv: box.privateKey, ed25519Pub: sign.publicKey, ed25519Priv: sign.privateKey };
}

// bundle plaintext is x25519Priv (32 bytes) ‖ ed25519Priv (64 bytes); public keys are recomputed on open
export async function sealBundle(keys: IdentityKeys, key: Uint8Array): Promise<SealedBundle> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = new Uint8Array([...keys.x25519Priv, ...keys.ed25519Priv]);
  const bundle = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  sodium.memzero(plaintext);

  return { bundle: toBase64(bundle), nonce: toBase64(nonce) };
}

/** Throws when the key is wrong or the bundle was tampered with */
export async function openBundle(sealed: SealedBundle, key: Uint8Array): Promise<IdentityKeys> {
  await sodium.ready;
  const plaintext = sodium.crypto_secretbox_open_easy(fromBase64(sealed.bundle), fromBase64(sealed.nonce), key);
  const x25519Priv = plaintext.slice(0, sodium.crypto_box_SECRETKEYBYTES);
  const ed25519Priv = plaintext.slice(sodium.crypto_box_SECRETKEYBYTES);
  sodium.memzero(plaintext);

  return {
    x25519Priv,
    x25519Pub: sodium.crypto_scalarmult_base(x25519Priv),
    ed25519Priv,
    ed25519Pub: sodium.crypto_sign_ed25519_sk_to_pk(ed25519Priv),
  };
}

export async function generateRecoveryKey(): Promise<Uint8Array> {
  await sodium.ready;

  return sodium.randombytes_buf(32);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 32 bytes as 13 groups of lowercase base32, e.g. "k7qw-m2pa-…" */
export function formatRecoveryKey(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }

  return out.match(/.{1,4}/g)!.join('-');
}

/** Accepts the formatted key with any case, spacing, or separators; returns 32 bytes only for a complete key */
export function parseRecoveryKey(text: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of text.toLowerCase().replace(/[^a-z2-7]/g, '')) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

// must produce exactly what credentialSigningInput builds in src/api/credentials.ts
export function signCredentials(update: CredentialUpdate, ed25519Priv: Uint8Array): string {
  const message = [
    'messenger/credentials/v1',
    update.authKey,
    update.kdf.version,
    update.kdf.memLimit,
    update.kdf.opsLimit,
    update.keyBundle,
    update.keyBundleNonce,
  ].join('\n');

  return toBase64(sodium.crypto_sign_detached(message, ed25519Priv));
}
