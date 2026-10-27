import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { sendEmail } from '../lib/email.js';
import { HttpError } from '../lib/http-error.js';
import { hashToken, randomToken } from '../auth/auth.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Inserts the invite without emailing it; a null inviter is the bootstrap script */
export async function issueInvite(email: string, inviterId: string | null, conversationId: string | null = null) {
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new HttpError(409, 'That email already has an account');
  }

  const token = randomToken();

  const invite = await prisma.invite.create({
    data: {
      tokenHash: hashToken(token),
      email,
      inviterId,
      conversationId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  return { invite, link: `${env.APP_ORIGIN}/invite?token=${token}` };
}

export async function createInvite(inviterId: string, email: string, conversationId: string | null = null): Promise<{ id: string; expiresAt: Date }> {
  const inviter = await prisma.user.findUniqueOrThrow({
    where: { id: inviterId },
    select: { name: true, email: true },
  });

  const { invite, link } = await issueInvite(email, inviterId, conversationId);

  await sendEmail({
    to: email,
    subject: `${inviter.name ?? inviter.email} invited you to Messenger`,
    text: `Sign up here: ${link}\n\nThis link expires in 7 days.`,
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
