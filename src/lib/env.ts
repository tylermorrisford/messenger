import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    DATABASE_REPLICA_URL: z.string().min(1).optional(),
    MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    JWT_SECRET: z.string().min(32),
    // jsonwebtoken types expiresIn as an ms-style duration, so a plain string would not typecheck
    JWT_EXPIRES_IN: z.templateLiteral([z.number(), z.enum(['s', 'm', 'h', 'd'])]).default('15m'),
    APP_ORIGIN: z.url().default('http://localhost:3001'),
    REGISTRATION_MODE: z.enum(['invite', 'open']).default('invite'),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).default('Messenger <onboarding@resend.dev>'),
  })
  .refine((values) => values.NODE_ENV !== 'production' || values.RESEND_API_KEY, {
    path: ['RESEND_API_KEY'],
    message: 'Required in production',
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
