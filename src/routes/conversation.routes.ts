import { Router } from 'express';
import { z } from 'zod';
import {
  addKey,
  addMember,
  createConversation,
  getConversation,
  getKeys,
  leave,
  listConversations,
  rotate,
} from '../api/conversations.js';
import { listMessages, sendMessage } from '../api/messages.js';
import { createInvite } from '../api/invites.js';
import { authenticate, requireUser } from '../middleware/auth.middleware.js';
import { HttpError } from '../lib/http-error.js';
import { base64Schema, emailSchema, signatureSchema, validateBody } from '../lib/validate.js';

const router = Router();

router.use(authenticate);

// crypto_box_seal of a 32-byte key is 80 bytes
const wrappedKeySchema = z.base64().length(108);

const selfKeySchema = z.object({
  recipientKeyVersion: z.int().positive(),
  wrappedKey: wrappedKeySchema,
  signature: signatureSchema,
});

const memberKeySchema = selfKeySchema.extend({
  recipientUserId: z.uuid(),
});

const createSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(100).optional(),
  key: selfKeySchema,
});

const inviteSchema = z.object({
  email: emailSchema,
});

const rotateSchema = z.object({
  expectedEpoch: z.int().positive(),
  removeUserId: z.uuid().optional(),
  wrappedKeys: z.array(memberKeySchema).min(1).max(100),
});

const messageSchema = z.object({
  epoch: z.int().positive(),
  senderKeyVersion: z.int().positive(),
  ttlSeconds: z.int().positive().max(365 * 24 * 60 * 60).optional(),
  // 24-byte XChaCha20 nonce
  nonce: z.base64().length(32),
  ciphertext: base64Schema,
  signature: signatureSchema,
});

const listMessagesSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * POST /api/conversations
 * Creates a conversation with the caller as owner; the client picks the id and wraps the first epoch key for itself
 */
router.post('/', validateBody(createSchema), async (req, res): Promise<void> => {
  const conversation = await createConversation(requireUser(req).userId, req.body);

  res.status(201).json({ success: true, data: conversation });
});

/**
 * GET /api/conversations
 * Every conversation the caller is an active member of
 */
router.get('/', async (req, res): Promise<void> => {
  res.json({ success: true, data: await listConversations(requireUser(req).userId) });
});

/**
 * GET /api/conversations/:id
 */
router.get('/:id', async (req, res): Promise<void> => {
  res.json({ success: true, data: await getConversation(req.params.id, requireUser(req).userId) });
});

/**
 * POST /api/conversations/:id/members
 * Adds an existing user along with the current epoch key wrapped for them
 */
router.post('/:id/members', validateBody(memberKeySchema), async (req, res): Promise<void> => {
  const member = await addMember(req.params.id, requireUser(req).userId, req.body);

  res.status(201).json({ success: true, data: member });
});

/**
 * POST /api/conversations/:id/invites
 * Emails a sign-up link that joins this conversation on registration
 */
router.post('/:id/invites', validateBody(inviteSchema), async (req, res): Promise<void> => {
  const { userId } = requireUser(req);
  await getConversation(req.params.id, userId);
  const invite = await createInvite(userId, req.body.email, req.params.id);

  res.status(201).json({ success: true, data: invite });
});

/**
 * POST /api/conversations/:id/leave
 */
router.post('/:id/leave', async (req, res): Promise<void> => {
  await leave(req.params.id, requireUser(req).userId);

  res.status(204).end();
});

/**
 * POST /api/conversations/:id/rotate
 * Starts a new epoch, optionally removing a member first
 */
router.post('/:id/rotate', validateBody(rotateSchema), async (req, res): Promise<void> => {
  res.json({ success: true, data: await rotate(req.params.id, requireUser(req).userId, req.body) });
});

/**
 * GET /api/conversations/:id/keys
 * The caller's wrapped keys for every epoch, and members still missing one for the current epoch
 */
router.get('/:id/keys', async (req, res): Promise<void> => {
  res.json({ success: true, data: await getKeys(req.params.id, requireUser(req).userId) });
});

/**
 * POST /api/conversations/:id/keys
 * Wraps the current epoch key for a member who is missing it
 */
router.post('/:id/keys', validateBody(memberKeySchema), async (req, res): Promise<void> => {
  await addKey(req.params.id, requireUser(req).userId, req.body);

  res.status(201).end();
});

/**
 * GET /api/conversations/:id/messages?after=&limit=
 * Unexpired messages after a sequence number, oldest first
 */
router.get('/:id/messages', async (req, res): Promise<void> => {
  const query = listMessagesSchema.safeParse(req.query);

  if (!query.success) {
    throw new HttpError(400, 'Invalid query');
  }

  const messages = await listMessages(req.params.id, requireUser(req).userId, query.data.after, query.data.limit);

  res.json({ success: true, data: messages });
});

/**
 * POST /api/conversations/:id/messages
 */
router.post('/:id/messages', validateBody(messageSchema), async (req, res): Promise<void> => {
  const message = await sendMessage(req.params.id, requireUser(req).userId, req.body);

  res.status(201).json({ success: true, data: message });
});

export default router;
