# Architecture

Messenger is a small end-to-end encrypted group chat for a known set of friends. The browser does all the cryptography; the server stores ciphertext, public keys, and memberships, and relays events. If the server (or its database, or a backup) leaks, the attacker gets metadata: who is in which conversation, when messages were sent, and how long they are. They do not get message text or private keys.

The one trade the design makes on purpose: decrypted keys live in the browser's IndexedDB so a reload doesn't ask for the password. A cross-site scripting bug in the client could read them, which is why the client ships a Content Security Policy and almost no third-party code.

```
Browser (Next.js static export, Nimbus UI, libsodium)        client/
   |  HTTPS: JSON API + one Server-Sent Events stream
   v
Cloudflare Pages ──> Cloudflare Tunnel ──> cloudflared pod ──> api pods (Express)      src/
                                                                    |
                                                                    v
                                                           Postgres (StatefulSet)     prisma/
                                                   sweep CronJob, pg-backup CronJob   deploy/
```

| Directory | What lives there |
|---|---|
| `client/` | Next.js 15 app, `output: 'export'`, served as static files. All crypto is in `client/lib/crypto/`. |
| `src/` | Express 5 API. `routes/` validate and call into `api/`, which owns transactions. `lib/` has env, Prisma, email, notify. |
| `prisma/` | Schema and hand-written migrations. |
| `deploy/` | GCP bootstrap, Kubernetes manifests, backup image, sleep and wake scripts. See `DEPLOYMENT.md`. |

## Client cryptography

Everything below is in `client/lib/crypto/` and uses libsodium (`libsodium-wrappers-sumo`) plus WebCrypto for HKDF. Each signed or encrypted structure starts with a version string such as `messenger/message/v1`, so a format change can't be confused with the old one. The server rebuilds the same strings in `src/api/*.ts` to verify signatures; the two copies are marked with a comment pointing at each other.

### Keys from the password (`kdf.ts`)

```
salt      = sha256(lowercase(trim(email)))[0..16]
masterKey = argon2id(NFKC(password), salt, mem 64 MiB, ops 3)       32 bytes
authKey   = HKDF-SHA256(masterKey, info "auth")                     sent to the server, base64
encKey    = HKDF-SHA256(masterKey, info "enc")                      never leaves the browser
```

The salt comes from the email so that login needs nothing from the server except the Argon2 parameters, which `GET /api/auth/params?email=` returns (defaults for unknown emails, so it doesn't reveal who has an account). The parameters are stored per user, so they can be raised later without a migration. The server bcrypts `authKey` and never sees the password or `encKey`.

### Identity (`keys.ts`)

Sign-up generates an X25519 key pair (for receiving wrapped conversation keys) and an Ed25519 key pair (for signing). The two private keys are concatenated and sealed with `crypto_secretbox` under `encKey`; that sealed blob and its nonce are the `keyBundle` the server stores. Opening the bundle recomputes the public keys, so the bundle can't be swapped for one whose private keys don't match.

A second copy of the bundle is sealed under a random 256-bit recovery key, shown once at sign-up as 13 groups of base32. Recovery is: prove you own the email, download that copy, open it with the recovery key, then set a new password with a credential update signed by the recovered Ed25519 key.

Public keys are versioned (`UserKey.version`). Old versions are retired, never deleted, so messages and key rows signed with them still verify.

### Credential changes

Any request that replaces `authHash` or `keyBundle` (password change, recovery) carries an Ed25519 signature by the account's *current* signing key over `messenger/credentials/v1`, the new auth key, the KDF parameters, and the new bundle. Someone who only controls the email cannot swap in a bundle they know the key to.

"I lost my password and my recovery key" is `POST /api/auth/reset-identity`: new identity keys, every session revoked, and the account leaves every conversation. The remaining members see a key change warning and re-add the person after checking the new safety number.

### Conversation keys and epochs (`conversation.ts`)

Each conversation has a symmetric key per epoch: 32 random bytes. The key is delivered to each member as a `ConversationKey` row: `crypto_box_seal(key, member.x25519Pub)`, plus an Ed25519 signature by whoever wrapped it over the conversation id, epoch, recipient, recipient key version, and the sealed bytes. The server verifies that signature and that the recipient key version is current; the client verifies it again against the distributor's key before unwrapping, because the server is not trusted to say who a key came from. Rows are signed one at a time, so adding a member never touches anyone else's row.

The epoch advances when someone leaves or is removed. The rotating client makes a fresh key, wraps it for exactly the remaining members, and posts them all in `POST /:id/rotate` with the epoch it expects. Until that happens the conversation is flagged `needsRotation` and the server refuses new messages. A new member gets the current epoch only, so they can read history back to the last rotation; with the 7-day default message lifetime that is usually everything.

### Messages (`message.ts`)

```
aad        = "messenger/message-aad/v1" ‖ conversationId ‖ senderId ‖ epoch ‖ ttlSeconds
ciphertext = XChaCha20-Poly1305(key_epoch, nonce, text, aad)
signature  = Ed25519(senderSigningKey, "messenger/message/v1" ‖ conversationId ‖ epoch ‖ nonce ‖ ciphertext)
```

The fields the server acts on (which conversation, who sent it, which epoch, how long it lives) are bound into the AEAD's additional data, so the server can't move a message to another sender or quietly change its expiry. The TTL stays in plaintext so the server can compute `expiresAt` and the sweep can delete the row. Recipients check the signature with the sender's key at `senderKeyVersion`, then decrypt. A failed check is shown as a failed message, never as text.

### Trust in other people's keys (`store.ts`, `safety-number.ts`)

The server hands out public keys, so a malicious server could hand out its own. The client pins the first key it sees for each user (trust on first use) in IndexedDB and keeps the pins across logout. When a key changes, the thread shows a warning and refuses to wrap conversation keys for that person until you click "Trust new key". The safety number is 60 digits from a BLAKE2b hash of both parties' Ed25519 public keys, the same from either side, for comparing out of band.

### What the browser stores

| Where | What | Cleared |
|---|---|---|
| Memory | access token | tab close |
| Cookie `refresh` (httpOnly, SameSite=Strict, `Path=/api/auth`, Secure in production) | refresh token | logout or 30 days |
| IndexedDB `identity` | decrypted private keys, user id, key version | logout |
| IndexedDB `conversationKeys` | decrypted epoch keys | logout |
| IndexedDB `pins` | trusted public keys per user | never |

The access token is never written to storage. Refresh runs under a `navigator.locks` lock so two tabs don't race, and logout is broadcast over a `BroadcastChannel` so every tab drops its keys.

## Server

Express 5 with helmet, CORS pinned to `APP_ORIGIN` with credentials, zod for every body, Prisma 7 over the `pg` adapter. Routes are thin: validate, call one function in `src/api/`, send. The `api/` functions own the transactions and throw `HttpError`, which the global handler turns into `{ success: false, error }`.

### Accounts and sessions

- Email codes: six digits, hashed with SHA-256, valid 10 minutes, five wrong guesses lock the code, each code is accepted once. A correct code returns an *email proof*: a 15-minute JWT with the email as subject and the purpose (`VERIFY` or `RECOVER`) inside.
- Registration: `REGISTRATION_MODE=invite` (the default) requires an invite token whose email matches. `open` requires a `VERIFY` email proof instead. Either way the server stores the bcrypt of `authKey`, the KDF parameters, both sealed bundles, and the first `UserKey`.
- Login: email plus `authKey`. Unknown email and wrong key get the same 401. Success returns an access token and sets the refresh cookie.
- Access token: HS256 JWT, `sub` = user id, `sid` = session id, audience `access`, 15 minutes by default (`JWT_EXPIRES_IN`).
- Refresh: random 32-byte token in the cookie, SHA-256 hash in `Session`. `POST /api/auth/refresh` rotates it. The previous token stays valid for 30 seconds so two tabs refreshing together don't trip reuse detection; a replay after that revokes the whole session. Sessions last 30 days. `DELETE /api/auth/refresh` is logout.
- Rate limits (per client IP, counted in each API pod): 10 per 15 minutes across register, login, verify, recover, and reset-identity; 5 per 15 minutes for sending an email code; 20 invites per hour per user. Over the limit is a 429 with `RateLimit` and `Retry-After` headers. Behind the tunnel the client IP comes from `X-Forwarded-For`, so `trust proxy` is 1 in production.

### Authorization and consistency

Every conversation route first checks the caller is an active member (`leftAt` null); non-members get a 404, not a 403. The two writes that race are guarded with row locks in one transaction:

- Sending a message takes `SELECT ... FOR SHARE` on the conversation, re-checks membership, rejects if `needsRotation` is set or the message's epoch isn't current, computes `expiresAt`, inserts, and publishes the event. A removed member's in-flight send can't land after the rotation commits.
- Rotating takes `FOR UPDATE`, requires `expectedEpoch` to match, lets only owners remove someone, and requires the wrapped keys to cover exactly the remaining members and no one else.

Leaving sets `leftAt` and `needsRotation`. If the owner leaves, ownership passes to the longest-standing member.

When `DATABASE_REPLICA_URL` is set, `@prisma/extension-read-replicas` sends reads outside transactions to the replica. Reads that decide a write (the session behind a refresh, the email code being verified, the key a signature is checked against) and the reads behind event fan-out call `prisma.$primary()`, so a lagging replica can't let a revoked session refresh or drop a notification. The user-facing reads that follow a create are the replica's problem to keep up with; `DEPLOYMENT.md` says how.

### Invites

`POST /api/invites` (or `POST /api/conversations/:id/invites`) creates an `Invite` with a 7-day expiry, stores only the SHA-256 of the token, and emails a link containing the token through Resend. No key material travels by email. When the invitee signs up, one transaction consumes the invite, creates the user, and, for a conversation invite, adds them as a member with no key yet, then publishes `member_needs_key`. The next member whose tab is open wraps the current epoch key for the newcomer and posts it; the newcomer's thread shows a waiting state until then. Inviting someone who already has an account skips email: the inviter wraps the key for their public key directly.

### Real-time

Writes call `publish(tx, ...)`, which runs `pg_notify('messenger', json)` inside the same transaction, so a rolled-back change is never announced. Each API pod holds one raw `pg.Client` on `LISTEN messenger` outside the Prisma pool and reconnects if it drops. On a notification the pod looks up which of *its* connected users are active members and pushes to them: `message` events carry the full row, `conversation` events carry the id and a reason (`member_added`, `member_needs_key`, `key_added`, `member_left`, `rotated`, `settings`). Someone who just left still receives the `member_left` event for that conversation.

`GET /api/events` is Server-Sent Events over `fetch` (plain `EventSource` can't send a bearer token). The server sends a `: ping` comment every 25 seconds because Cloudflare closes streams idle for 100, and ends the stream when the access token expires, so a revoked session loses its stream within 15 minutes. Anything published while a client was disconnected is gone, so the client reloads the thread and the list on every (re)connect, backing off up to 15 seconds between attempts and stopping on a 401. After the pod's own `LISTEN` connection reconnects it sends every open stream a `resync` for the same reason.

### Disappearing messages

`expiresAt = createdAt + (message.ttlSeconds ?? conversation.defaultTtlSeconds)`; the default is 7 days and `null` means never. Reads filter expired rows, and the client hides a message at its expiry using the server's timestamp. `src/jobs/sweep.ts` deletes expired rows 1000 at a time; a CronJob runs it every 5 minutes. The sweep only reclaims space, so a missed run changes nothing visible.

### Endpoints

| Area | Endpoints |
|---|---|
| Auth | `GET /api/auth/params`, `POST register`, `POST login`, `POST`/`DELETE refresh`, `POST email-code`, `POST verify`, `GET me`, `PUT password`, `POST recover/bundle`, `POST recover`, `POST reset-identity` |
| Users | `GET /api/users?email=` (public keys for a friend), `GET /api/users/:id/keys` (key history) |
| Invites | `POST /api/invites`, `GET /api/invites/:token` |
| Conversations | `POST`/`GET /api/conversations`, `GET`/`PATCH /:id`, `POST /:id/members`, `POST /:id/invites`, `POST /:id/leave`, `POST /:id/rotate`, `GET`/`POST /:id/keys`, `GET`/`POST /:id/messages` |
| Events | `GET /api/events` (SSE) |
| Health | `GET /health` (pings the database; the readiness probe) |

## Data model

All ids are UUIDv7. Emails are stored lowercased and trimmed.

| Model | Purpose | Worth knowing |
|---|---|---|
| `User` | account | `authHash` is bcrypt of the client-derived auth key, never of the password. Holds both sealed bundles and the KDF parameters. |
| `UserKey` | public key history | `(userId, version)` unique; `retiredAt` instead of delete. |
| `Session` | refresh tokens | `refreshHash` unique, `previousHash` + `rotatedAt` for the grace window, `revokedAt`. |
| `EmailCode` | one-time codes | hash, expiry, attempt counter, `consumedAt`. |
| `Invite` | sign-up links | token hash only; optional conversation; cascades if the inviter's account goes. |
| `Conversation` | group | `currentEpoch`, `defaultTtlSeconds`, `needsRotation`. `createdById` has no relation so the row outlives its creator. |
| `ConversationMember` | membership | composite key, `role`, `leftAt` soft delete so "was this person a member at epoch N" stays answerable. |
| `ConversationKey` | wrapped epoch keys | unique on `(conversationId, epoch, recipientUserId)`; distributor id has no relation so recipients keep their key if the distributor's account goes. |
| `Message` | ciphertext | `seq` is a database sequence used as the paging cursor; indexed on `(conversationId, seq)` and on `expiresAt`. |

## Infrastructure

Full walkthrough, costs, and operations are in `DEPLOYMENT.md`. The shape:

- The client is static files on Cloudflare Pages. `client/public/_headers` sets the CSP: `script-src 'self' 'wasm-unsafe-eval'` (the last for libsodium's WebAssembly) plus a `sha256-` source per inline script, which `client/scripts/csp-hashes.mjs` computes from the exported HTML after `next build`; `frame-ancestors 'none'`; and `connect-src` limited to the API origin.
- The API runs on a one-node GKE cluster behind a Cloudflare Tunnel. Nothing on the node listens to the internet; the `cloudflared` pod dials out and forwards to the `api` Service. A second, Spot-priced node pool scales from 0 to 3 for `api` pods when the first node is full.
- `api` is a Deployment behind a HorizontalPodAutoscaler (1 to 6 replicas at 70% CPU) with a Prisma `migrate deploy` init container, a readiness probe on `/health`, and a PodDisruptionBudget. The image is multi-stage, runs as `node`, and ships only production dependencies plus `prisma` for the migration step.
- Postgres 16 is a single StatefulSet with a 10 GiB persistent disk. A nightly CronJob runs `pg_dump`, checks the archive, uploads it to a GCS bucket, keeps the newest 7, and pings healthchecks.io. The sweep is a CronJob every 5 minutes.
- Secrets live in Secret Manager and are copied into Kubernetes Secrets by `deploy/gcp/bootstrap.sh`. GitHub Actions deploys on every green CI run on `main` using Workload Identity Federation; there are no service account keys anywhere.
- `deploy/scripts/sleep.sh` and `wake.sh` (also Actions workflows) scale everything to zero and back, keeping the disk and the bucket.

## Known limits

- The server sees metadata: membership, timing, message sizes, and IP addresses in its logs.
- No forward secrecy inside an epoch. An epoch key leaked from a member's browser decrypts every message of that epoch that still exists; the lifetime default and rotation on membership change are the mitigation.
- Multi-device works by logging in with the password on each device, which downloads and opens the key bundle. Linking a new device from an existing one without the password is not built.
- Login requires the password; the `LOGIN` email code purpose exists in the schema but has no endpoint.
- Rate limit counters are per API pod, so the effective limit is the configured number times the replica count. A shared store (Postgres or Redis) is the upgrade if that matters.
- One Postgres, no standby, nightly backups: the recovery point is up to 24 hours. `DEPLOYMENT.md` describes the step up to CloudNativePG.
