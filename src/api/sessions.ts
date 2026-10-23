import { prisma } from '../lib/prisma.js';
import { hashToken, randomToken, signAccessToken } from '../auth/auth.js';

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// two tabs refreshing at the same moment both present the old token; the loser must not look like theft
const ROTATION_GRACE_MS = 30_000;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
}

export async function createSession(userId: string, userAgent: string | undefined): Promise<IssuedSession> {
  const refreshToken = randomToken();

  const session = await prisma.session.create({
    data: {
      userId,
      refreshHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: userAgent ?? null,
    },
  });

  return { accessToken: signAccessToken({ userId, sessionId: session.id }), refreshToken };
}

export interface RotatedSession {
  accessToken: string;
  refreshToken?: string;
}

export async function rotateSession(refreshToken: string): Promise<RotatedSession | null> {
  const hash = hashToken(refreshToken);
  const now = new Date();

  const session = await prisma.session.findFirst({
    where: { OR: [{ refreshHash: hash }, { previousHash: hash }] },
  });

  if (!session || session.revokedAt || session.expiresAt < now) {
    return null;
  }

  const accessToken = signAccessToken({ userId: session.userId, sessionId: session.id });

  if (session.previousHash === hash) {
    const withinGrace =
      session.rotatedAt !== null && now.getTime() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;

    if (!withinGrace) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
      return null;
    }

    return { accessToken };
  }

  const next = randomToken();

  const rotated = await prisma.session.updateMany({
    where: { id: session.id, refreshHash: hash },
    data: { refreshHash: hashToken(next), previousHash: hash, rotatedAt: now, lastUsedAt: now },
  });

  // lost a race with a concurrent refresh of the same token, which already rotated it
  if (rotated.count === 0) {
    return { accessToken };
  }

  return { accessToken, refreshToken: next };
}

export async function revokeSession(refreshToken: string): Promise<void> {
  const hash = hashToken(refreshToken);

  await prisma.session.updateMany({
    where: { OR: [{ refreshHash: hash }, { previousHash: hash }], revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
