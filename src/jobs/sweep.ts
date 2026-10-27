import { sweepExpired } from '../api/messages.js';
import { prisma } from '../lib/prisma.js';

try {
  const deleted = await sweepExpired();
  console.log(`Deleted ${deleted} expired ${deleted === 1 ? 'message' : 'messages'}`);
} finally {
  await prisma.$disconnect();
}
