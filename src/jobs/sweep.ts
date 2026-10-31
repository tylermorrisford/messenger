import { dropMessagePartitions, ensureMessagePartitions, sweepExpired } from '../api/messages.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';

try {
  await ensureMessagePartitions();
  const dropped = await dropMessagePartitions(env.MESSAGE_RETENTION_DAYS);
  const deleted = await sweepExpired();
  console.log(`Dropped ${dropped.length} ${dropped.length === 1 ? 'partition' : 'partitions'}${dropped.length > 0 ? ` (${dropped.join(', ')})` : ''}`);
  console.log(`Deleted ${deleted} expired ${deleted === 1 ? 'message' : 'messages'}`);
} finally {
  await prisma.$disconnect();
}
