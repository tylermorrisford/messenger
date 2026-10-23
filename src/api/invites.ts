import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { sendEmail } from '../lib/email.js';
import { HttpError } from '../lib/http-error.js';
import { hashToken, randomToken } from '../auth/auth.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createInvite(inviterId: string, email: string): Promise<{ id: string; expiresAt: Date }> {
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new HttpError(409, 'That email already has an account');
  }

  const inviter = await prisma.user.findUniqueOrThrow({
    where: { id: inviterId },
    select: { name: true, email: true },
  });

  const token = randomToken();

  const invite = await prisma.invite.create({
    data: {
      tokenHash: hashToken(token),
      email,
      inviterId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  await sendEmail({
    to: email,
    subject: `${inviter.name ?? inviter.email} invited you to Messenger`,
    text: `Sign up here: ${env.APP_ORIGIN}/invite?token=${token}\n\nThis link expires in 7 days.`,
  });

  return { id: invite.id, expiresAt: invite.expiresAt };
}

export async function findOpenInvite(token: string) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(token) } });

  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return null;
  }

  return invite;
}
