# Messenger

A small end-to-end encrypted messaging service for a handful of friends. Express 5 + Prisma 7 + PostgreSQL on the server, Next.js in `client/`.

The server never sees a password or a private key. The client derives an auth key from the password (Argon2id + HKDF) and sends only that; the server bcrypt-hashes it. Identity keys are generated on the client and stored encrypted (`keyBundle`), so the server only ever holds ciphertext and public keys.

## Project Structure

```
messenger/
├── docker-compose.yml      # Dev and test PostgreSQL containers
├── Dockerfile              # Multi-stage production image
├── prisma/
│   ├── schema.prisma       # User, UserKey, Session, EmailCode, Invite
│   └── migrations/
├── src/
│   ├── lib/
│   │   ├── env.ts          # Validated environment (fails fast)
│   │   ├── email.ts        # Resend in production, console in dev
│   │   ├── http-error.ts   # Throw to answer with a status code
│   │   ├── prisma.ts       # Prisma client instance
│   │   └── validate.ts     # zod request validation middleware
│   ├── auth/
│   │   ├── auth.ts         # JWTs, token hashing, bcrypt
│   │   └── user.ts         # Register, login, KDF params, public keys
│   ├── api/
│   │   ├── sessions.ts     # Refresh token rotation
│   │   ├── email-codes.ts  # 6-digit email codes -> short-lived proofs
│   │   └── invites.ts      # Invite links
│   ├── routes/             # Express routers + supertest specs
│   ├── middleware/
│   │   └── auth.middleware.ts # Bearer access token check
│   ├── test/               # vitest global setup, mocks, helpers
│   └── server.ts           # Express app
├── client/                 # Next.js app
├── .github/workflows/ci.yml # Typecheck + tests on every push and PR
├── .env.example            # Environment variables the server reads
└── package.json
```

## Prerequisites

- Node.js 22+
- Docker (for PostgreSQL)
- pnpm

## Quick Start

### 1. Start PostgreSQL

```bash
pnpm docker:up
```

This starts two PostgreSQL 16 containers:
- `messaging` on port `5432` for development (data persists in a volume)
- `messaging_test` on port `5433` for the test suite (in-memory, wiped on restart)

Both use user `msguser` and password `msgpass123`.

### 2. Install and configure

```bash
pnpm install
cp .env.example .env
```

The server refuses to start unless every required variable in `.env.example` is set (and `JWT_SECRET` is at least 32 characters).

### 3. Migrate

```bash
pnpm db:migrate
```

### 4. Run

```bash
pnpm dev
```

The API listens on `http://localhost:3000`. Emails (sign-up codes, invites) print to the console unless `RESEND_API_KEY` is set.

For a production-style run, compile first:

```bash
pnpm build
pnpm start
```

### 5. Create the first account

Registration is invite-only, and invites can only be sent by someone who already has an account. To bootstrap, run the server once with open registration:

```bash
REGISTRATION_MODE=open pnpm dev
```

Sign up (the verification code prints to the console), then restart with the default `REGISTRATION_MODE=invite`. From then on, invite people from inside the app.

### 6. Test

```bash
pnpm test
```

Tests run against the `messaging_test` database and apply pending migrations on every run. If the migration history is ever rewritten, recreate the container: `docker compose up -d --force-recreate postgres-test`.

## Available Commands

### Application

```bash
pnpm dev              # Start API server with auto-reload
pnpm build            # Compile TypeScript to dist/
pnpm start            # Run the compiled server
pnpm typecheck        # tsc --noEmit
pnpm test             # Run the test suite once
pnpm test:watch       # Run tests in watch mode
```

### Database

```bash
pnpm db:studio        # Open Prisma Studio
pnpm db:migrate       # Create and apply a new migration
pnpm db:generate      # Regenerate Prisma Client
pnpm db:push          # Push schema changes without a migration
pnpm db:reset         # Reset the database (deletes all data)
```

### Docker

```bash
pnpm docker:up        # Start the PostgreSQL containers
pnpm docker:down      # Stop them
pnpm docker:logs      # Tail PostgreSQL logs
```

## API

Base URL: `http://localhost:3000`. Every response is `{ success, data }` or `{ success: false, error }`; validation failures add `issues`.

### Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/params?email=` | none | KDF parameters to derive the auth key with (defaults for unknown emails) |
| `POST` | `/api/auth/email-code` | none | Email a 6-digit code (`purpose`: `VERIFY`, `LOGIN`, `RECOVER`) |
| `POST` | `/api/auth/verify` | none | Trade a code for a 15-minute proof JWT |
| `POST` | `/api/auth/register` | invite token or `VERIFY` proof | Create the account, store the encrypted key bundle, start a session |
| `POST` | `/api/auth/login` | none | Returns the access token, KDF params, encrypted key bundle, and current public keys |
| `POST` | `/api/auth/refresh` | `refresh` cookie | Rotate the refresh token, return a new access token |
| `DELETE` | `/api/auth/refresh` | `refresh` cookie | Log out (revoke the session) |
| `GET` | `/api/auth/me` | Bearer | Current user |
| `PUT` | `/api/auth/password` | Bearer | New auth key and re-encrypted key bundle, signed by the current identity key; logs out other sessions |
| `POST` | `/api/auth/recover/bundle` | `RECOVER` proof | The key bundle sealed under the recovery key |
| `POST` | `/api/auth/recover` | `RECOVER` proof | Forgot password: new credentials signed by the recovered identity key; logs out everywhere |
| `POST` | `/api/auth/reset-identity` | `RECOVER` proof | Lost recovery key: new identity keys, old ones retired, logs out everywhere |

### Invites and users

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/invites` | Bearer | Email someone a sign-up link (7-day expiry) |
| `GET` | `/api/invites/:token` | none | Which email the invite is locked to |
| `GET` | `/api/users/:id/keys` | Bearer | A user's public keys, every version |

### Sessions

Access tokens are 15-minute JWTs sent as `Authorization: Bearer`. The refresh token lives in an httpOnly cookie scoped to `/api/auth`, rotates on every refresh, and expires after 30 days. Replaying an old refresh token outside a 30-second grace window revokes the session.

## Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DATABASE_REPLICA_URL` | unset | A streaming replica. Reads outside transactions go here; writes, transactions, and reads that decide a write stay on `DATABASE_URL` |
| `JWT_SECRET` | required | At least 32 characters |
| `JWT_EXPIRES_IN` | `15m` | Access token lifetime |
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | |
| `APP_ORIGIN` | `http://localhost:3001` | CORS origin and the base of invite links |
| `REGISTRATION_MODE` | `invite` | `open` lets anyone with a verified email sign up |
| `RESEND_API_KEY` | unset | Required in production; emails log to the console without it |
| `EMAIL_FROM` | `Messenger <onboarding@resend.dev>` | Sender address |

`src/lib/env.ts` validates these at startup and throws if anything is missing or malformed.

## Deployment

```bash
docker build -t messenger-api .
docker run --rm -p 3000:3000 --env-file .env messenger-api
```

The image contains the compiled server, production dependencies, and the Prisma CLI, so the same image can run `prisma migrate deploy`. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full walkthrough.

## Troubleshooting

### Database connection failed

1. Check Docker is running: `docker ps`
2. Check PostgreSQL is healthy: `pnpm docker:logs`
3. Verify `DATABASE_URL` in `.env`

### Prisma Client not found

```bash
pnpm db:generate
```

### Migration failed

```bash
pnpm db:reset
```

## License

MIT
