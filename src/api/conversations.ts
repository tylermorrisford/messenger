import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import { publish } from '../lib/notify.js';
import { verifyEd25519 } from '../auth/auth.js';

export interface WrappedKey {
  recipientUserId: string;
  recipientKeyVersion: number;
  wrappedKey: string;
  signature: string;
}

const memberSelect = {
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { name: true, email: true } },
} satisfies Prisma.ConversationMemberSelect;

const conversationSelect = {
  id: true,
  title: true,
  currentEpoch: true,
  defaultTtlSeconds: true,
  needsRotation: true,
  createdById: true,
  createdAt: true,
  members: { where: { leftAt: null }, orderBy: { joinedAt: 'asc' }, select: memberSelect },
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;
type MemberRow = Prisma.ConversationMemberGetPayload<{ select: typeof memberSelect }>;

function serializeMember({ user, ...member }: MemberRow) {
  return { ...member, ...user };
}

function serialize({ members, ...conversation }: ConversationRow) {
  return { ...conversation, members: members.map(serializeMember) };
}

// the client signs exactly this string; bump the prefix if the field list ever changes
export function conversationKeySigningInput(key: Omit<WrappedKey, 'signature'> & { conversationId: string; epoch: number }): string {
  return [
    'messenger/conversation-key/v1',
    key.conversationId,
    key.epoch,
    key.recipientUserId,
    key.recipientKeyVersion,
    key.wrappedKey,
  ].join('\n');
}

export async function requireActiveMember(conversationId: string, userId: string, tx: Tx = prisma) {
  const member = await tx.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId }, leftAt: null },
    select: { role: true },
  });

  if (!member) {
    throw new HttpError(404, 'Conversation not found');
  }

  return member;
}

/** Row locks serialize epoch changes: sends and key wraps share the lock, a rotation takes it exclusively */
export async function lockConversation(tx: Tx, conversationId: string, mode: 'SHARE' | 'UPDATE') {
  const [row] = await tx.$queryRaw<{ currentEpoch: number; needsRotation: boolean; defaultTtlSeconds: number | null }[]>`
    SELECT "currentEpoch", "needsRotation", "defaultTtlSeconds" FROM "conversations" WHERE "id" = ${conversationId} FOR ${Prisma.raw(mode)}
  `;

  if (!row) {
    throw new HttpError(404, 'Conversation not found');
  }

  return row;
}

export async function currentKey(userId: string, tx: Tx = prisma) {
  const key = await tx.userKey.findFirst({
    where: { userId, retiredAt: null },
    orderBy: { version: 'desc' },
    select: { version: true, ed25519Pub: true },
  });

  if (!key) {
    throw new HttpError(404, 'User not found');
  }

  return key;
}

/** Checks each recipient is an active member on their current key and that the caller signed the row */
async function verifiedKeyRows(
  tx: Tx,
  conversationId: string,
  epoch: number,
  distributorUserId: string,
  keys: WrappedKey[],
  activeMembers: { userId: string }[],
): Promise<Prisma.ConversationKeyCreateManyInput[]> {
  const distributor = await currentKey(distributorUserId, tx);
  const rows: Prisma.ConversationKeyCreateManyInput[] = [];

  for (const key of keys) {
    if (!activeMembers.some((member) => member.userId === key.recipientUserId)) {
      throw new HttpError(400, 'Every recipient must be an active member');
    }

    const recipientKey = await currentKey(key.recipientUserId, tx);
    if (recipientKey.version !== key.recipientKeyVersion) {
      throw new HttpError(409, 'A recipient has a newer identity key; reload and try again');
    }

    const input = conversationKeySigningInput({ ...key, conversationId, epoch });
    if (!verifyEd25519(distributor.ed25519Pub, input, key.signature)) {
      throw new HttpError(403, 'Key signature does not match your identity key');
    }

    rows.push({
      conversationId,
      epoch,
      recipientUserId: key.recipientUserId,
      recipientKeyVersion: key.recipientKeyVersion,
      wrappedKey: key.wrappedKey,
      distributorUserId,
      distributorKeyVersion: distributor.version,
      signature: key.signature,
    });
  }

  return rows;
}

/** The client picks the id so it can sign its own wrapped key before the conversation exists */
export async function createConversation(
  userId: string,
  input: { id: string; title?: string; key: Omit<WrappedKey, 'recipientUserId'> },
) {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { id: input.id, title: input.title ?? null, createdById: userId, members: { create: { userId, role: 'OWNER' } } },
      select: conversationSelect,
    });

    const rows = await verifiedKeyRows(
      tx,
      conversation.id,
      conversation.currentEpoch,
      userId,
      [{ ...input.key, recipientUserId: userId }],
      conversation.members,
    );
    await tx.conversationKey.createMany({ data: rows });

    return serialize(conversation);
  });
}

export async function listConversations(userId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { members: { some: { userId, leftAt: null } } },
    orderBy: { createdAt: 'desc' },
    select: conversationSelect,
  });

  return conversations.map(serialize);
}

export async function getConversation(conversationId: string, userId: string) {
  await requireActiveMember(conversationId, userId);

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: conversationSelect,
  });

  return serialize(conversation);
}

/** Any member can change how long new messages live; null means they never expire */
export async function updateSettings(conversationId: string, userId: string, input: { defaultTtlSeconds: number | null }) {
  await requireActiveMember(conversationId, userId);

  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { defaultTtlSeconds: input.defaultTtlSeconds },
    select: conversationSelect,
  });
  await publish(prisma, { type: 'conversation', conversationId, reason: 'settings' });

  return serialize(conversation);
}

/** Adds someone who already has an account, with the current epoch key wrapped for them in the same transaction */
export async function addMember(conversationId: string, userId: string, key: WrappedKey) {
  await requireActiveMember(conversationId, userId);

  return prisma.$transaction(async (tx) => {
    const { currentEpoch } = await lockConversation(tx, conversationId, 'SHARE');

    const existing = await tx.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: key.recipientUserId } },
      select: { leftAt: true },
    });
    if (existing && !existing.leftAt) {
      throw new HttpError(409, 'Already a member');
    }

    const member = await tx.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId: key.recipientUserId } },
      create: { conversationId, userId: key.recipientUserId },
      update: { role: 'MEMBER', joinedAt: new Date(), leftAt: null },
      select: memberSelect,
    });

    const rows = await verifiedKeyRows(tx, conversationId, currentEpoch, userId, [key], [member]);
    await tx.conversationKey.createMany({ data: rows });
    await publish(tx, { type: 'conversation', conversationId, reason: 'member_added' });

    return serializeMember(member);
  });
}

/** The caller's wrapped keys for every epoch, plus active members still waiting on a key for the current one */
export async function getKeys(conversationId: string, userId: string) {
  await requireActiveMember(conversationId, userId);

  const [conversation, mine] = await Promise.all([
    prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        currentEpoch: true,
        members: {
          where: { leftAt: null },
          select: {
            userId: true,
            user: { select: { keys: { where: { retiredAt: null }, orderBy: { version: 'desc' }, take: 1 } } },
          },
        },
        keys: { select: { recipientUserId: true, epoch: true } },
      },
    }),
    prisma.conversationKey.findMany({
      where: { conversationId, recipientUserId: userId },
      orderBy: { epoch: 'asc' },
      select: {
        epoch: true,
        recipientKeyVersion: true,
        wrappedKey: true,
        distributorUserId: true,
        distributorKeyVersion: true,
        signature: true,
      },
    }),
  ]);

  const missing = conversation.members
    .filter(
      (member) =>
        !conversation.keys.some((key) => key.epoch === conversation.currentEpoch && key.recipientUserId === member.userId),
    )
    .map(({ userId, user: { keys: [key] } }) => ({
      userId,
      keyVersion: key.version,
      x25519Pub: key.x25519Pub,
      ed25519Pub: key.ed25519Pub,
    }));

  return { epoch: conversation.currentEpoch, mine, missing };
}

/** Wraps the current epoch for a member who joined through an invite and has no key yet */
export async function addKey(conversationId: string, userId: string, key: WrappedKey): Promise<void> {
  await requireActiveMember(conversationId, userId);

  await prisma.$transaction(async (tx) => {
    const { currentEpoch } = await lockConversation(tx, conversationId, 'SHARE');

    const existing = await tx.conversationKey.findUnique({
      where: { conversationId_epoch_recipientUserId: { conversationId, epoch: currentEpoch, recipientUserId: key.recipientUserId } },
      select: { id: true },
    });
    if (existing) {
      throw new HttpError(409, 'That member already has a key for this epoch');
    }

    const members = await tx.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } });
    const rows = await verifiedKeyRows(tx, conversationId, currentEpoch, userId, [key], members);
    await tx.conversationKey.createMany({ data: rows });
    await publish(tx, { type: 'conversation', conversationId, reason: 'key_added' });
  });
}

/** Marks the member gone and flags the conversation so nobody can send until a remaining member rotates */
export async function leaveConversation(tx: Tx, conversationId: string, userId: string, now: Date): Promise<void> {
  const member = await tx.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { leftAt: now },
    select: { role: true },
  });
  await publish(tx, { type: 'conversation', conversationId, reason: 'member_left', leftUserId: userId });

  const remaining = await tx.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true, role: true },
  });

  if (remaining.length === 0) {
    return;
  }

  if (member.role === 'OWNER' && !remaining.some((other) => other.role === 'OWNER')) {
    await tx.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: remaining[0].userId } },
      data: { role: 'OWNER' },
    });
  }

  await tx.conversation.update({ where: { id: conversationId }, data: { needsRotation: true } });
}

export async function leave(conversationId: string, userId: string): Promise<void> {
  await requireActiveMember(conversationId, userId);

  await prisma.$transaction((tx) => leaveConversation(tx, conversationId, userId, new Date()));
}

export interface RotateInput {
  expectedEpoch: number;
  removeUserId?: string;
  wrappedKeys: WrappedKey[];
}

/** Starts a new epoch; the wrapped keys must cover exactly the members who remain after the optional removal */
export async function rotate(conversationId: string, userId: string, input: RotateInput): Promise<{ epoch: number }> {
  const caller = await requireActiveMember(conversationId, userId);

  if (input.removeUserId !== undefined) {
    if (caller.role !== 'OWNER') {
      throw new HttpError(403, 'Only an owner can remove members');
    }
    if (input.removeUserId === userId) {
      throw new HttpError(400, 'Leave the conversation instead of removing yourself');
    }
  }

  return prisma.$transaction(async (tx) => {
    const { currentEpoch } = await lockConversation(tx, conversationId, 'UPDATE');

    if (currentEpoch !== input.expectedEpoch) {
      throw new HttpError(409, 'The conversation key changed; reload and try again');
    }

    if (input.removeUserId !== undefined) {
      const removed = await tx.conversationMember.updateMany({
        where: { conversationId, userId: input.removeUserId, leftAt: null },
        data: { leftAt: new Date() },
      });
      if (removed.count === 0) {
        throw new HttpError(404, 'That user is not a member');
      }
    }

    const remaining = await tx.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } });
    const recipients = new Set(input.wrappedKeys.map((key) => key.recipientUserId));

    if (recipients.size !== input.wrappedKeys.length || recipients.size !== remaining.length) {
      throw new HttpError(400, 'Wrapped keys must cover exactly the remaining members');
    }

    const epoch = currentEpoch + 1;
    const rows = await verifiedKeyRows(tx, conversationId, epoch, userId, input.wrappedKeys, remaining);

    await tx.conversationKey.createMany({ data: rows });
    await tx.conversation.update({ where: { id: conversationId }, data: { currentEpoch: epoch, needsRotation: false } });
    await publish(tx, { type: 'conversation', conversationId, reason: 'rotated', leftUserId: input.removeUserId });

    return { epoch };
  });
}
