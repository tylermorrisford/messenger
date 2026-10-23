import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // jsonwebtoken types expiresIn as an ms-style duration, so a plain string would not typecheck
  JWT_EXPIRES_IN: z.templateLiteral([z.number(), z.enum(['s', 'm', 'h', 'd'])]).default('7d'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
