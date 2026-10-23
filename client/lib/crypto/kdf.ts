import sodium from 'libsodium-wrappers-sumo';

export interface KdfParams {
  version: number;
  memLimit: number;
  opsLimit: number;
}

export const KDF_DEFAULTS: KdfParams = { version: 1, memLimit: 64 * 1024 * 1024, opsLimit: 3 };

export interface DerivedKeys {
  /** base64, the only secret the server ever sees */
  authKey: string;
  /** 32 bytes, never leaves the browser */
  encKey: Uint8Array;
}

const encoder = new TextEncoder();

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function hkdf(masterKey: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(masterKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    key,
    256,
  );

  return new Uint8Array(bits);
}

export async function deriveKeys(email: string, password: string, kdf: KdfParams): Promise<DerivedKeys> {
  await sodium.ready;

  // the salt is public and derived from the email so login needs nothing from the server but the params
  const salt = sodium.crypto_hash_sha256(normalizeEmail(email)).subarray(0, sodium.crypto_pwhash_SALTBYTES);
  const masterKey = sodium.crypto_pwhash(
    32,
    encoder.encode(password.normalize('NFKC')),
    salt,
    kdf.opsLimit,
    kdf.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  const [authKey, encKey] = await Promise.all([hkdf(masterKey, 'auth'), hkdf(masterKey, 'enc')]);
  sodium.memzero(masterKey);

  return { authKey: sodium.to_base64(authKey, sodium.base64_variants.ORIGINAL), encKey };
}
