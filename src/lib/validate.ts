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
