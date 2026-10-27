import pg from 'pg';
import type { Prisma } from '@prisma/client';
import { env } from './env.js';

const CHANNEL = 'messenger';
const RECONNECT_MS = 2000;

export type ConversationChange = 'member_added' | 'member_needs_key' | 'key_added' | 'member_left' | 'rotated' | 'settings';

export type Notification =
  | { type: 'message'; conversationId: string; id: string }
  | { type: 'conversation'; conversationId: string; reason: ConversationChange; leftUserId?: string }
  | { type: 'resync' };

type Listener = (notification: Notification) => void;

const listeners = new Set<Listener>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let closed = false;

/** Postgres holds the notification until the transaction commits, so a rolled-back change never gets announced */
export async function publish(tx: Prisma.TransactionClient, notification: Notification): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(notification)})`;
}

export function onNotification(listener: Listener): void {
  listeners.add(listener);
}

function broadcast(notification: Notification): void {
  for (const listener of listeners) {
    listener(notification);
  }
}

async function connect(): Promise<void> {
  const next = new pg.Client({ connectionString: env.DATABASE_URL });

  next.on('error', (error) => console.error('Notify connection error:', error));
  next.on('notification', ({ payload }) => {
    if (payload) {
      // only publish() writes to this channel
      broadcast(JSON.parse(payload) as Notification);
    }
  });
  next.on('end', () => {
    if (client === next) {
      client = null;
    }
    if (!closed) {
      void reconnect();
    }
  });

  await next.connect();
  await next.query(`LISTEN ${CHANNEL}`);
  client = next;

  // anything published while the connection was down is lost, so every open stream has to catch up
  if (listeners.size > 0) {
    broadcast({ type: 'resync' });
  }
}

async function reconnect(): Promise<void> {
  while (!closed && !client) {
    try {
      await listen();
    } catch (error) {
      console.error('Notify reconnect failed:', error);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }
}

/** Resolves once LISTEN is in place, so a caller that syncs afterwards cannot miss a change */
export function listen(): Promise<void> {
  if (client) {
    return Promise.resolve();
  }

  connecting ??= connect().finally(() => {
    connecting = null;
  });

  return connecting;
}

export async function close(): Promise<void> {
  closed = true;
  listeners.clear();
  await client?.end();
  client = null;
}
