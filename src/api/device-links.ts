import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import { verifyEd25519 } from '../auth/auth.js';
import type { PublicUser } from '../auth/user.js';
import { createSession, type IssuedSession } from './sessions.js';

/** Long enough to read a code off one screen and type it on another, short enough to bound a brute force of the code */
export const LINK_TTL_MS = 5 * 60 * 1000;

export interface StartLinkInput {
  linkId: string;
  ephemeralPub: string;
  mac: string;
}

export interface ApproveLinkInput {
  sealedBundle: string;
  bundleMac: string;
}

export type LinkStatus = { approved: false } | { approved: true; sealedBundle: string; bundleMac: string };

export interface ClaimedLink extends IssuedSession {
  user: PublicUser;
  keys: { version: number; x25519Pub: string; ed25519Pub: string };
}

// the client signs exactly this string; bump the prefix if the field list ever changes
export function deviceLinkSigningInput(linkId: string): string {
  return ['messenger/device-link/v1', linkId].join('\n');
}

async function findLiveLink(linkId: string) {
  const link = await prisma.$primary().deviceLink.findUnique({ where: { id: linkId } });

  if (!link || link.expiresAt < new Date()) {
    throw new HttpError(404, 'No device is waiting with that code');
  }

  return link;
}

export async function startDeviceLink(input: StartLinkInput): Promise<{ expiresAt: Date }> {
  const link = await prisma.deviceLink.create({
    data: { id: input.linkId, ephemeralPub: input.ephemeralPub, mac: input.mac, expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    select: { expiresAt: true },
  });

  return link;
}

export async function getLinkingDevice(linkId: string): Promise<{ ephemeralPub: string; mac: string }> {
  const link = await findLiveLink(linkId);

  if (link.userId) {
    throw new HttpError(409, 'That device has already been approved');
  }

  return { ephemeralPub: link.ephemeralPub, mac: link.mac };
}

export async function approveDeviceLink(linkId: string, userId: string, input: ApproveLinkInput): Promise<void> {
  const approved = await prisma.deviceLink.updateMany({
    where: { id: linkId, userId: null, expiresAt: { gt: new Date() } },
    data: { userId, sealedBundle: input.sealedBundle, bundleMac: input.bundleMac },
  });

  if (approved.count === 0) {
    // tells the caller which of the two it was
    await getLinkingDevice(linkId);
  }
}

export async function getDeviceLinkStatus(linkId: string): Promise<LinkStatus> {
  const link = await findLiveLink(linkId);

  return link.userId && link.sealedBundle && link.bundleMac
    ? { approved: true, sealedBundle: link.sealedBundle, bundleMac: link.bundleMac }
    : { approved: false };
}

export async function claimDeviceLink(linkId: string, signature: string, userAgent: string | undefined): Promise<ClaimedLink> {
  const link = await findLiveLink(linkId);

  if (!link.userId) {
    throw new HttpError(409, 'No device has approved this link yet');
  }

  const [user, key] = await Promise.all([
    prisma.$primary().user.findUnique({ where: { id: link.userId }, select: { id: true, email: true, name: true } }),
    prisma.$primary().userKey.findFirst({
      where: { userId: link.userId, retiredAt: null },
      orderBy: { version: 'desc' },
      select: { version: true, x25519Pub: true, ed25519Pub: true },
    }),
  ]);

  if (!user || !key || !verifyEd25519(key.ed25519Pub, deviceLinkSigningInput(linkId), signature)) {
    throw new HttpError(403, 'Signature does not match the identity key of the approving account');
  }

  // a link is good for one session; the loser of a concurrent claim sees it as gone
  const consumed = await prisma.deviceLink.deleteMany({ where: { id: linkId } });

  if (consumed.count === 0) {
    throw new HttpError(404, 'No device is waiting with that code');
  }

  const session = await createSession(user.id, userAgent);

  return { ...session, user, keys: key };
}

export async function sweepDeviceLinks(): Promise<number> {
  const { count } = await prisma.deviceLink.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  return count;
}
