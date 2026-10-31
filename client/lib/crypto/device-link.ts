import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, identityFromSecrets, identitySecrets, toBase64, type IdentityKeys } from './keys';

/** The ephemeral key pair a new device makes for one link; the private half never leaves it */
export interface EphemeralKeys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface PendingLink {
  /** What the person reads off this screen and types on the other device */
  code: string;
  linkId: string;
  ephemeral: EphemeralKeys;
}

export interface LinkRequest {
  linkId: string;
  ephemeralPub: string;
  mac: string;
}

export interface SealedForDevice {
  sealedBundle: string;
  bundleMac: string;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

// 60 bits: a server that only holds the hash cannot find the code inside the link's five-minute life
const CODE_LENGTH = 12;

export function normalizeLinkCode(text: string): string {
  return text.toLowerCase().replace(/[^a-z2-7]/g, '');
}

function derive(code: string, purpose: 'id' | 'mac'): Uint8Array {
  return sodium.crypto_generichash(32, ['messenger/device-link/v1', purpose, normalizeLinkCode(code)].join('\n'), null);
}

/** Hex, because it travels in a URL path */
export async function linkIdFor(code: string): Promise<string> {
  await sodium.ready;

  return sodium.to_hex(derive(code, 'id'));
}

export async function startLink(): Promise<PendingLink & { request: LinkRequest }> {
  await sodium.ready;
  const digits = sodium.randombytes_buf(CODE_LENGTH);
  const raw = Array.from(digits, (byte) => BASE32[byte % 32]).join('');
  const code = raw.match(/.{4}/g)!.join('-');
  const ephemeral = sodium.crypto_box_keypair();
  const ephemeralPub = toBase64(ephemeral.publicKey);
  const linkId = await linkIdFor(code);
  const mac = toBase64(sodium.crypto_auth(`device\n${ephemeralPub}`, derive(code, 'mac')));

  return { code, linkId, ephemeral, request: { linkId, ephemeralPub, mac } };
}

/** True when the ephemeral key the server handed over was made by a device that knows this code */
export async function verifyLinkingDevice(code: string, ephemeralPub: string, mac: string): Promise<boolean> {
  await sodium.ready;

  return sodium.crypto_auth_verify(fromBase64(mac), `device\n${ephemeralPub}`, derive(code, 'mac'));
}

export async function sealForDevice(keys: IdentityKeys, code: string, ephemeralPub: string): Promise<SealedForDevice> {
  await sodium.ready;
  const plaintext = identitySecrets(keys);
  const sealedBundle = toBase64(sodium.crypto_box_seal(plaintext, fromBase64(ephemeralPub)));
  sodium.memzero(plaintext);

  return { sealedBundle, bundleMac: toBase64(sodium.crypto_auth(`bundle\n${sealedBundle}`, derive(code, 'mac'))) };
}

/** Throws when the bundle was not sealed by a device that knows the code, or was not sealed to this ephemeral key */
export async function openFromDevice(code: string, ephemeral: EphemeralKeys, sealed: SealedForDevice): Promise<IdentityKeys> {
  await sodium.ready;

  if (!sodium.crypto_auth_verify(fromBase64(sealed.bundleMac), `bundle\n${sealed.sealedBundle}`, derive(code, 'mac'))) {
    throw new Error('The approval did not come from a device that knows this code');
  }

  const plaintext = sodium.crypto_box_seal_open(fromBase64(sealed.sealedBundle), ephemeral.publicKey, ephemeral.privateKey);
  sodium.memzero(ephemeral.privateKey);

  return identityFromSecrets(plaintext);
}

// must produce exactly what deviceLinkSigningInput builds in src/api/device-links.ts
export function signLinkClaim(linkId: string, ed25519Priv: Uint8Array): string {
  return toBase64(sodium.crypto_sign_detached(['messenger/device-link/v1', linkId].join('\n'), ed25519Priv));
}
