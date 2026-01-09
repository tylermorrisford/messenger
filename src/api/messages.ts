import { prisma } from '../lib/prisma.js';

export interface CreateMessageInput {
  content: string;
  authorId: number;
}

export interface UpdateMessageInput {
  content: string;
}

// Create a new message
export async function createMessage(input: CreateMessageInput) {
  const { content, authorId } = input;

  return prisma.message.create({
    data: {
      content,
      authorId,
    },
    include: {
      author: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

// Get all messages (with author info)
export async function getAllMessages() {
  return prisma.message.findMany({
    include: {
      author: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// Get message by ID
export async function getMessageById(messageId: number) {
  return prisma.message.findUnique({
    where: { id: messageId },
    include: {
      author: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

// Get messages by user
export async function getMessagesByUser(userId: number) {
  return prisma.message.findMany({
    where: { authorId: userId },
    include: {
      author: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// Update a message
export async function updateMessage(messageId: number, input: UpdateMessageInput) {
  const { content } = input;

  return prisma.message.update({
    where: { id: messageId },
    data: { content },
    include: {
      author: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

// Delete a message
export async function deleteMessage(messageId: number) {
  return prisma.message.delete({
    where: { id: messageId },
  });
}

// Delete all messages by a user
export async function deleteAllMessagesByUser(userId: number) {
  return prisma.message.deleteMany({
    where: { authorId: userId },
  });
}
