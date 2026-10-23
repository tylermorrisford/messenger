import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http-error.js';
import { findOpenInvite } from '../api/invites.js';
import { hashPassword, verifyEmailProof, verifyPassword } from './auth.js';

export interface KdfParams {
  version: number;
  memLimit: number;
  opsLimit: number;
}

export const KDF_DEFAULTS: KdfParams = { version: 1, memLimit: 64 * 1024 * 1024, opsLimit: 3 };

// a real bcrypt hash of nothing, so a login for an unknown email takes as long as a wrong key
const UNKNOWN_USER_HASH = '$2b$10$5a9.rkKr1sERHonh.wAtq.VtXeHR5AeFBBv3pKjEmu3qMh9mR6cK.';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
}

export interface RegisterInput {
  email: string;
  name?: string;
  authKey: string;
  kdf: KdfParams;
  x25519Pub: string;
  ed25519Pub: string;
  keyBundle: string;
  keyBundleNonce: string;
  recoveryBundle: string;
  recoveryBundleNonce: string;
  inviteToken?: string;
  emailProof?: string;
}

export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const invite = input.inviteToken ? await findOpenInvite(input.inviteToken) : null;

  if (input.inviteToken && (!invite || invite.email !== input.email)) {
    throw new HttpError(400, 'This invite is invalid or has expired');
  }

  if (!invite) {
    if (env.REGISTRATION_MODE !== 'open') {
      throw new HttpError(403, 'Registration is invite-only');
    }
    if (!input.emailProof || verifyEmailProof(input.emailProof, 'VERIFY') !== input.email) {
      throw new HttpError(400, 'Email verification required');
    }
  }

  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw new HttpError(409, 'That email already has an account');
  }

  const authHash = await hashPassword(input.authKey);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        emailVerifiedAt: now,
        authHash,
        kdfVersion: input.kdf.version,
        kdfMemLimit: input.kdf.memLimit,
        kdfOpsLimit: input.kdf.opsLimit,
        keyBundle: input.keyBundle,
        keyBundleNonce: input.keyBundleNonce,
        recoveryBundle: input.recoveryBundle,
        recoveryBundleNonce: input.recoveryBundleNonce,
        keys: {
          create: { version: 1, x25519Pub: input.x25519Pub, ed25519Pub: input.ed25519Pub },
        },
      },
      select: { id: true, email: true, name: true },
    });

    if (invite) {
      const accepted = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: now, acceptedByUserId: user.id },
      });
      if (accepted.count === 0) {
        throw new HttpError(400, 'This invite is invalid or has expired');
      }
    }

    return user;
  });
}

export interface LoginInput {
  email: string;
  authKey: string;
}

export interface LoginResult {
  user: PublicUser;
  kdf: KdfParams;
  keyBundle: string;
  keyBundleNonce: string;
  keys: { version: number; x25519Pub: string; ed25519Pub: string };
}

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: {
      keys: {
        where: { retiredAt: null },
        orderBy: { version: 'desc' },
        take: 1,
        select: { version: true, x25519Pub: true, ed25519Pub: true },
      },
    },
  });

  const valid = await verifyPassword(input.authKey, user?.authHash ?? UNKNOWN_USER_HASH);

  if (!user || !valid) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const [keys] = user.keys;

  return {
    user: { id: user.id, email: user.email, name: user.name },
    kdf: { version: user.kdfVersion, memLimit: user.kdfMemLimit, opsLimit: user.kdfOpsLimit },
    keyBundle: user.keyBundle,
    keyBundleNonce: user.keyBundleNonce,
    keys,
  };
}

export async function getKdfParams(email: string): Promise<KdfParams> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { kdfVersion: true, kdfMemLimit: true, kdfOpsLimit: true },
  });

  return user
    ? { version: user.kdfVersion, memLimit: user.kdfMemLimit, opsLimit: user.kdfOpsLimit }
    : KDF_DEFAULTS;
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, isAdmin: true, createdAt: true },
  });
}

export async function getUserKeys(userId: string) {
  return prisma.userKey.findMany({
    where: { userId },
    orderBy: { version: 'asc' },
    select: { version: true, x25519Pub: true, ed25519Pub: true, createdAt: true, retiredAt: true },
  });
}
