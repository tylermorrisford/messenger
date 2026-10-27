import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import { hashPassword, verifyEd25519, verifyEmailProof } from '../auth/auth.js';
import { leaveConversation } from './conversations.js';
import type { KdfParams, PublicUser } from '../auth/user.js';

export interface CredentialUpdate {
  authKey: string;
  kdf: KdfParams;
  keyBundle: string;
  keyBundleNonce: string;
}

export interface SignedCredentialUpdate extends CredentialUpdate {
  signature: string;
}

export interface IdentityReset extends CredentialUpdate {
  x25519Pub: string;
  ed25519Pub: string;
  recoveryBundle: string;
  recoveryBundleNonce: string;
}

// the client signs exactly this string; bump the prefix if the field list ever changes
export function credentialSigningInput(update: CredentialUpdate): string {
  return [
    'messenger/credentials/v1',
    update.authKey,
    update.kdf.version,
    update.kdf.memLimit,
    update.kdf.opsLimit,
    update.keyBundle,
    update.keyBundleNonce,
  ].join('\n');
}

function credentialColumns(update: CredentialUpdate, authHash: string) {
  return {
    authHash,
    kdfVersion: update.kdf.version,
    kdfMemLimit: update.kdf.memLimit,
    kdfOpsLimit: update.kdf.opsLimit,
    keyBundle: update.keyBundle,
    keyBundleNonce: update.keyBundleNonce,
  };
}

async function verifySignedUpdate(userId: string, update: SignedCredentialUpdate): Promise<void> {
  const key = await prisma.userKey.findFirst({
    where: { userId, retiredAt: null },
    orderBy: { version: 'desc' },
    select: { ed25519Pub: true },
  });

  if (!key || !verifyEd25519(key.ed25519Pub, credentialSigningInput(update), update.signature)) {
    throw new HttpError(403, 'Signature does not match the current identity key');
  }
}

async function userFromRecoveryProof(emailProof: string) {
  const email = verifyEmailProof(emailProof, 'RECOVER');

  if (!email) {
    throw new HttpError(400, 'Email verification required');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, recoveryBundle: true, recoveryBundleNonce: true },
  });

  if (!user) {
    throw new HttpError(404, 'No account for that email');
  }

  return user;
}

export async function changePassword(
  userId: string,
  sessionId: string,
  update: SignedCredentialUpdate,
): Promise<void> {
  await verifySignedUpdate(userId, update);
  const authHash = await hashPassword(update.authKey);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: credentialColumns(update, authHash) }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null, id: { not: sessionId } },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function getRecoveryBundle(emailProof: string) {
  const { recoveryBundle, recoveryBundleNonce } = await userFromRecoveryProof(emailProof);

  return { recoveryBundle, recoveryBundleNonce };
}

export async function recoverAccount(emailProof: string, update: SignedCredentialUpdate): Promise<PublicUser> {
  const { id, email, name } = await userFromRecoveryProof(emailProof);
  await verifySignedUpdate(id, update);
  const authHash = await hashPassword(update.authKey);

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: credentialColumns(update, authHash) }),
    prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  return { id, email, name };
}

export async function resetIdentity(emailProof: string, reset: IdentityReset): Promise<PublicUser> {
  const { id, email, name } = await userFromRecoveryProof(emailProof);
  const authHash = await hashPassword(reset.authKey);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const latest = await tx.userKey.findFirst({
      where: { userId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    await tx.userKey.updateMany({ where: { userId: id, retiredAt: null }, data: { retiredAt: now } });
    await tx.userKey.create({
      data: {
        userId: id,
        version: (latest?.version ?? 0) + 1,
        x25519Pub: reset.x25519Pub,
        ed25519Pub: reset.ed25519Pub,
      },
    });
    await tx.user.update({
      where: { id },
      data: {
        ...credentialColumns(reset, authHash),
        recoveryBundle: reset.recoveryBundle,
        recoveryBundleNonce: reset.recoveryBundleNonce,
      },
    });
    await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });

    // the old keys are gone for good, so every conversation has to re-key without this user
    const memberships = await tx.conversationMember.findMany({ where: { userId: id, leftAt: null }, select: { conversationId: true } });
    for (const { conversationId } of memberships) {
      await leaveConversation(tx, conversationId, id, now);
    }
  });

  return { id, email, name };
}
