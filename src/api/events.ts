import { prisma } from '../lib/prisma.js';
import { onNotification, type Notification } from '../lib/notify.js';
import { findMessage } from './messages.js';

export interface ServerEvent {
  event: 'message' | 'conversation' | 'resync';
  data: unknown;
}

type Handler = (event: ServerEvent) => void;

const handlers = new Map<string, Set<Handler>>();
let listening = false;

function deliver(userIds: Iterable<string>, event: ServerEvent): void {
  for (const userId of userIds) {
    for (const handler of handlers.get(userId) ?? []) {
      handler(event);
    }
  }
}

async function dispatch(notification: Notification): Promise<void> {
  if (handlers.size === 0) {
    return;
  }

  if (notification.type === 'resync') {
    deliver(handlers.keys(), { event: 'resync', data: {} });
    return;
  }

  const members = await prisma.$primary().conversationMember.findMany({
    where: { conversationId: notification.conversationId, leftAt: null, userId: { in: [...handlers.keys()] } },
    select: { userId: true },
  });
  const recipients = new Set(members.map((member) => member.userId));

  if (notification.type === 'message') {
    const message = await findMessage(notification.id);
    if (message) {
      deliver(recipients, { event: 'message', data: message });
    }
    return;
  }

  // someone who just left is no longer a member but still needs to hear it
  if (notification.leftUserId) {
    recipients.add(notification.leftUserId);
  }
  deliver(recipients, { event: 'conversation', data: { conversationId: notification.conversationId, reason: notification.reason } });
}

export function subscribe(userId: string, handler: Handler): () => void {
  if (!listening) {
    listening = true;
    onNotification((notification) => {
      dispatch(notification).catch((error: unknown) => console.error('Event dispatch failed:', error));
    });
  }

  let set = handlers.get(userId);
  if (!set) {
    set = new Set();
    handlers.set(userId, set);
  }
  set.add(handler);

  return () => {
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(userId);
    }
  };
}
