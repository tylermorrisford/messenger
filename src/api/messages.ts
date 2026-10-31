import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import { publish } from '../lib/notify.js';
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
  const senderKey = await prisma.$primary().userKey.findUnique({
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

    const created = await tx.message.create({
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
    await publish(tx, { type: 'message', conversationId, id: created.id });

    return created;
  });

  return serialize(message);
}

export async function findMessage(id: string) {
  // the primary key is (id, createdAt) because of partitioning; the id alone is still unique
  const message = await prisma.$primary().message.findFirst({ where: { id }, select: messageSelect });

  return message ? serialize(message) : null;
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

function utcMonth(offset: number): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function partitionName(month: Date): string {
  return `messages_${month.toISOString().slice(0, 7).replace('-', '_')}`;
}

/** Partitions for this month and next, so a sweep that misses a month boundary doesn't fail every send */
export async function ensureMessagePartitions(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // two pods booting together would both pass IF NOT EXISTS and one would fail on the catalog insert
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('messages_partitions'))`;

    for (const offset of [0, 1]) {
      const from = utcMonth(offset).toISOString().slice(0, 10);
      const to = utcMonth(offset + 1).toISOString().slice(0, 10);

      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${partitionName(utcMonth(offset))}" PARTITION OF "messages" FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
    }
  });
}

/**
 * Drops past months in which every message has expired, and past months older than the retention cap
 * even when some of their messages were set to never expire. Returns the partitions dropped.
 */
export async function dropMessagePartitions(retentionDays: number | undefined): Promise<string[]> {
  const partitions = await prisma.$queryRaw<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'messages'::regclass AND c.relname < ${partitionName(utcMonth(0))}
    ORDER BY c.relname
  `;
  const cutoff = retentionDays === undefined ? null : Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const dropped: string[] = [];

  for (const { name } of partitions) {
    const [year, month] = name.slice('messages_'.length).split('_').map(Number);
    const end = Date.UTC(year, month, 1);

    if (cutoff === null || end > cutoff) {
      const [{ live }] = await prisma.$queryRawUnsafe<{ live: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM "${name}" WHERE "expiresAt" IS NULL OR "expiresAt" > now()) AS live`,
      );

      if (live) {
        continue;
      }
    }

    await prisma.$executeRawUnsafe(`DROP TABLE "${name}"`);
    dropped.push(name);
  }

  return dropped;
}
