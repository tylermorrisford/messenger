import type { RequestHandler } from 'express';
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

// 32 raw bytes, base64-encoded
export const key32Schema = z.base64().length(44);

export const base64Schema = z.base64().max(16_384);

export function validateBody<S extends z.ZodType>(
  schema: S,
): RequestHandler<Record<string, string>, unknown, z.output<S>> {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request body',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    req.body = result.data;
    next();
  };
}

// 64-byte Ed25519 signature, base64-encoded
export const signatureSchema = z.base64().length(88);

export const kdfSchema = z.object({
  version: z.literal(1),
  memLimit: z.int().positive(),
  opsLimit: z.int().positive(),
});

// 32-byte BLAKE2b hash, hex so it can sit in a URL path
export const linkIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
