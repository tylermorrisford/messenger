import { randomInt, timingSafeEqual } from 'node:crypto';
import type { EmailCodePurpose } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { sendEmail } from '../lib/email.js';
import { HttpError } from '../lib/http-error.js';
import { hashToken, signEmailProof } from '../auth/auth.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export async function issueEmailCode(email: string, purpose: EmailCodePurpose): Promise<void> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

  await prisma.emailCode.create({
    data: { email, purpose, codeHash: hashToken(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });

  await sendEmail({
    to: email,
    subject: 'Your Messenger code',
    text: `Your code is ${code}. It expires in 10 minutes.`,
  });
}

export async function verifyEmailCode(email: string, purpose: EmailCodePurpose, code: string): Promise<string> {
  const record = await prisma.emailCode.findFirst({
    where: { email, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!record || record.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(400, 'Invalid or expired code');
  }

  if (!timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(hashToken(code)))) {
    await prisma.emailCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new HttpError(400, 'Invalid or expired code');
  }

  await prisma.emailCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });

  return signEmailProof(email, purpose);
}
