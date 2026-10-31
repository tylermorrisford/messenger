import { sweepDeviceLinks } from '../api/device-links.js';
import { dropMessagePartitions, ensureMessagePartitions, sweepExpired } from '../api/messages.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';

try {
  await ensureMessagePartitions();
  const dropped = await dropMessagePartitions(env.MESSAGE_RETENTION_DAYS);
  const deleted = await sweepExpired();
  const links = await sweepDeviceLinks();
  console.log(`Dropped ${dropped.length} ${dropped.length === 1 ? 'partition' : 'partitions'}${dropped.length > 0 ? ` (${dropped.join(', ')})` : ''}`);
  console.log(`Deleted ${deleted} expired ${deleted === 1 ? 'message' : 'messages'}`);
  console.log(`Deleted ${links} expired device ${links === 1 ? 'link' : 'links'}`);
} finally {
  await prisma.$disconnect();
}
