import sodium from 'libsodium-wrappers-sumo';

const DIGITS = 60;

/** 60 digits in groups of 5 that two people compare out of band; the same from either side */
export async function safetyNumber(ed25519PubA: string, ed25519PubB: string): Promise<string> {
  await sodium.ready;
  const [first, second] = [ed25519PubA, ed25519PubB].sort();
  const hash = sodium.crypto_generichash(32, ['messenger/safety-number/v1', first, second].join('\n'), null);
  const digits = (BigInt(`0x${sodium.to_hex(hash)}`) % BigInt(`1${'0'.repeat(DIGITS)}`)).toString().padStart(DIGITS, '0');

  return digits.match(/.{5}/g)!.join(' ');
}
