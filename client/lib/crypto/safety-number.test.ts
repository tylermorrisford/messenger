import { describe, expect, it } from 'vitest';
import { generateIdentity, toBase64 } from './keys';
import { safetyNumber } from './safety-number';

describe('safetyNumber', () => {
  it('is 60 digits in groups of 5 and the same from either side', async () => {
    const alice = toBase64((await generateIdentity()).ed25519Pub);
    const bob = toBase64((await generateIdentity()).ed25519Pub);

    const number = await safetyNumber(alice, bob);

    expect(number).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(await safetyNumber(bob, alice)).toBe(number);
  });

  it('changes when either key changes', async () => {
    const alice = toBase64((await generateIdentity()).ed25519Pub);
    const bob = toBase64((await generateIdentity()).ed25519Pub);
    const mallory = toBase64((await generateIdentity()).ed25519Pub);

    expect(await safetyNumber(alice, mallory)).not.toBe(await safetyNumber(alice, bob));
  });
});
