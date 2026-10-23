import { issueInvite } from '../api/invites.js';
import { prisma } from '../lib/prisma.js';
import { emailSchema } from '../lib/validate.js';

const email = emailSchema.safeParse(process.argv[2]);

if (!email.success) {
  console.error('Usage: pnpm invite <email>');
  process.exit(1);
}

try {
  const { link } = await issueInvite(email.data, null);
  console.log(link);
} finally {
  await prisma.$disconnect();
}
