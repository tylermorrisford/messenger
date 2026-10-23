import { createPublicKey, verify } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';
import { deriveKeys } from './kdf';
import {
  formatRecoveryKey,
  fromBase64,
  generateIdentity,
  generateRecoveryKey,
  openBundle,
  parseRecoveryKey,
  sealBundle,
  signCredentials,
  toBase64,
} from './keys';

// the smallest Argon2id parameters libsodium accepts, so the suite stays fast
const KDF = { version: 1, memLimit: 8 * 1024, opsLimit: 1 };

describe('deriveKeys', () => {
  it('is deterministic and ignores email case and whitespace', async () => {
    const a = await deriveKeys('Alice@Example.com ', 'correct horse', KDF);
    const b = await deriveKeys('alice@example.com', 'correct horse', KDF);

    expect(a.authKey).toBe(b.authKey);
    expect(a.encKey).toEqual(b.encKey);
  });

  it('produces a 32-byte auth key and a different enc key', async () => {
    const { authKey, encKey } = await deriveKeys('alice@example.com', 'correct horse', KDF);

    expect(authKey).toHaveLength(44);
    expect(encKey).toHaveLength(32);
    expect(toBase64(encKey)).not.toBe(authKey);
  });

  it('changes with the password', async () => {
    const a = await deriveKeys('alice@example.com', 'correct horse', KDF);
    const b = await deriveKeys('alice@example.com', 'correct horse!', KDF);

    expect(a.authKey).not.toBe(b.authKey);
  });
});

describe('key bundle', () => {
  it('round-trips the identity and recomputes the public keys', async () => {
    const keys = await generateIdentity();
    const { encKey } = await deriveKeys('alice@example.com', 'correct horse', KDF);

    const opened = await openBundle(await sealBundle(keys, encKey), encKey);

    expect(opened).toEqual(keys);
  });

  it('rejects a flipped ciphertext byte', async () => {
    const keys = await generateIdentity();
    const { encKey } = await deriveKeys('alice@example.com', 'correct horse', KDF);
    const sealed = await sealBundle(keys, encKey);
    const bytes = fromBase64(sealed.bundle);
    bytes[10] ^= 1;

    await expect(openBundle({ ...sealed, bundle: toBase64(bytes) }, encKey)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const keys = await generateIdentity();
    const { encKey } = await deriveKeys('alice@example.com', 'correct horse', KDF);
    const other = await deriveKeys('alice@example.com', 'wrong horse', KDF);

    await expect(openBundle(await sealBundle(keys, encKey), other.encKey)).rejects.toThrow();
  });
});

describe('recovery key', () => {
  it('formats as 13 groups and parses back regardless of case and separators', async () => {
    const key = await generateRecoveryKey();
    const formatted = formatRecoveryKey(key);

    expect(formatted).toMatch(/^([a-z2-7]{4}-){12}[a-z2-7]{4}$/);
    expect(parseRecoveryKey(formatted)).toEqual(key);
    expect(parseRecoveryKey(formatted.toUpperCase().replaceAll('-', ' '))).toEqual(key);
  });

  it('unlocks a bundle sealed under it', async () => {
    const keys = await generateIdentity();
    const recoveryKey = await generateRecoveryKey();

    const opened = await openBundle(await sealBundle(keys, recoveryKey), parseRecoveryKey(formatRecoveryKey(recoveryKey)));

    expect(opened).toEqual(keys);
  });
});

describe('signCredentials', () => {
  it('verifies with Node crypto the way the server does', async () => {
    const keys = await generateIdentity();
    const update = { authKey: toBase64(sodium.randombytes_buf(32)), kdf: KDF, keyBundle: 'YWJj', keyBundleNonce: 'ZGVm' };

    const signature = signCredentials(update, keys.ed25519Priv);

    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keys.ed25519Pub).toString('base64url') },
      format: 'jwk',
    });
    const message = ['messenger/credentials/v1', update.authKey, 1, KDF.memLimit, KDF.opsLimit, 'YWJj', 'ZGVm'].join('\n');

    expect(signature).toHaveLength(88);
    expect(verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    expect(verify(null, Buffer.from(message + ' '), publicKey, Buffer.from(signature, 'base64'))).toBe(false);
  });
});
