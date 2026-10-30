import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

const log: ('query' | 'error' | 'warn')[] = env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'];

function connect(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString })), log });
}

// Reads outside a transaction go to the replica; writes and transactions stay on the primary. Reads that decide
// a write or pick event recipients call $primary() so they can't trail replication. Without a replica URL the
// primary stands in for itself, which keeps one client type everywhere.
function createClient() {
  const primary = connect(env.DATABASE_URL);
  const replica = env.DATABASE_REPLICA_URL ? connect(env.DATABASE_REPLICA_URL) : primary;

  return primary.$extends(readReplicas({ replicas: [replica] }));
}

// Prevent multiple Prisma Client instances in development
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createClient();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// an extended client's transaction callback isn't a Prisma.TransactionClient
export type Tx = Omit<typeof prisma, ITXClientDenyList>;
