import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import { verifyEd25519 } from '../auth/auth.js';
import { lockConversation, requireActiveMember } from './conversations.js';

export interface SendMessageInput {
  epoch: number;
  senderKeyVersion: number;
  ttlSeconds?: number;
  nonce: string;
  ciphertext: string;
  signature: string;
}

const messageSelect = {
  id: true,
  seq: true,
  conversationId: true,
  senderId: true,
  senderKeyVersion: true,
  epoch: true,
  ttlSeconds: true,
  nonce: true,
  ciphertext: true,
  signature: true,
  createdAt: true,
  expiresAt: true,
};

// the client signs exactly this string; bump the prefix if the field list ever changes
export function messageSigningInput(message: { conversationId: string; epoch: number; nonce: string; ciphertext: string }): string {
  return ['messenger/message/v1', message.conversationId, message.epoch, message.nonce, message.ciphertext].join('\n');
}

// JSON has no BigInt; seq stays well under 2^53
function serialize<T extends { seq: bigint }>({ seq, ...message }: T) {
  return { ...message, seq: Number(seq) };
}

export async function sendMessage(conversationId: string, userId: string, input: SendMessageInput) {
  const senderKey = await prisma.userKey.findUnique({
    where: { userId_version: { userId, version: input.senderKeyVersion }, retiredAt: null },
    select: { ed25519Pub: true },
  });

  if (!senderKey || !verifyEd25519(senderKey.ed25519Pub, messageSigningInput({ ...input, conversationId }), input.signature)) {
    throw new HttpError(403, 'Message signature does not match your identity key');
  }

  const message = await prisma.$transaction(async (tx) => {
    const locked = await lockConversation(tx, conversationId, 'SHARE');
    await requireActiveMember(conversationId, userId, tx);

    if (locked.needsRotation) {
      throw new HttpError(409, 'A member left; rotate the key before sending');
    }
    if (locked.currentEpoch !== input.epoch) {
      throw new HttpError(409, 'The conversation key changed; reload and try again');
    }

    const now = new Date();
    const ttlSeconds = input.ttlSeconds ?? locked.defaultTtlSeconds;

    return tx.message.create({
      data: {
        conversationId,
        senderId: userId,
        senderKeyVersion: input.senderKeyVersion,
        epoch: input.epoch,
        ttlSeconds: input.ttlSeconds ?? null,
        nonce: input.nonce,
        ciphertext: input.ciphertext,
        signature: input.signature,
        createdAt: now,
        expiresAt: ttlSeconds === null ? null : new Date(now.getTime() + ttlSeconds * 1000),
      },
      select: messageSelect,
    });
  });

  return serialize(message);
}

export async function listMessages(conversationId: string, userId: string, after: number, limit: number) {
  await requireActiveMember(conversationId, userId);

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      seq: { gt: after },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { seq: 'asc' },
    take: limit,
    select: messageSelect,
  });

  return messages.map(serialize);
}

const SWEEP_BATCH = 1000;

/** Reads already hide expired rows; this only reclaims space, in batches so a backlog never holds one long lock */
export async function sweepExpired(): Promise<number> {
  let total = 0;
  let deleted: number;

  do {
    deleted = await prisma.$executeRaw`
      DELETE FROM "messages" WHERE "id" IN (SELECT "id" FROM "messages" WHERE "expiresAt" < now() LIMIT ${SWEEP_BATCH})
    `;
    total += deleted;
  } while (deleted === SWEEP_BATCH);

  return total;
}
