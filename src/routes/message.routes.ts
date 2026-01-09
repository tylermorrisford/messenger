import { Router, Response } from 'express';
import {
  createMessage,
  getAllMessages,
  getMessageById,
  getMessagesByUser,
  updateMessage,
  deleteMessage,
} from '../api/messages.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * GET /api/messages
 * Get all messages
 * Authentication optional (but recommended for tracking)
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const messages = await getAllMessages();

    res.json({
      success: true,
      data: messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch messages',
    });
  }
});

/**
 * GET /api/messages/:id
 * Get a specific message
 */
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const messageId = parseInt(req.params.id);

    if (isNaN(messageId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid message ID',
      });
      return;
    }

    const message = await getMessageById(messageId);

    if (!message) {
      res.status(404).json({
        success: false,
        error: 'Message not found',
      });
      return;
    }

    res.json({
      success: true,
      data: message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch message',
    });
  }
});

/**
 * GET /api/messages/user/:userId
 * Get all messages by a specific user
 */
router.get('/user/:userId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
      });
      return;
    }

    const messages = await getMessagesByUser(userId);

    res.json({
      success: true,
      data: messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user messages',
    });
  }
});

/**
 * POST /api/messages
 * Create a new message (requires authentication)
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    if (content.length > 5000) {
      res.status(400).json({
        success: false,
        error: 'Message content too long (max 5000 characters)',
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }

    const message = await createMessage({
      content: content.trim(),
      authorId: req.user.userId,
    });

    res.status(201).json({
      success: true,
      data: message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to create message',
    });
  }
});

/**
 * PUT /api/messages/:id
 * Update a message (requires authentication and ownership)
 */
router.put('/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const messageId = parseInt(req.params.id);
    const { content } = req.body;

    if (isNaN(messageId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid message ID',
      });
      return;
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }

    // Check if message exists and user owns it
    const existingMessage = await getMessageById(messageId);

    if (!existingMessage) {
      res.status(404).json({
        success: false,
        error: 'Message not found',
      });
      return;
    }

    if (existingMessage.authorId !== req.user.userId) {
      res.status(403).json({
        success: false,
        error: 'You can only edit your own messages',
      });
      return;
    }

    // Update message
    const updatedMessage = await updateMessage(messageId, {
      content: content.trim(),
    });

    res.json({
      success: true,
      data: updatedMessage,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update message',
    });
  }
});

/**
 * DELETE /api/messages/:id
 * Delete a message (requires authentication and ownership)
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const messageId = parseInt(req.params.id);

    if (isNaN(messageId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid message ID',
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }

    // Check if message exists and user owns it
    const existingMessage = await getMessageById(messageId);

    if (!existingMessage) {
      res.status(404).json({
        success: false,
        error: 'Message not found',
      });
      return;
    }

    if (existingMessage.authorId !== req.user.userId) {
      res.status(403).json({
        success: false,
        error: 'You can only delete your own messages',
      });
      return;
    }

    // Delete message
    await deleteMessage(messageId);

    res.json({
      success: true,
      message: 'Message deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete message',
    });
  }
});

export default router;
