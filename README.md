# Messaging System with PostgreSQL, Prisma & JWT Auth

A bare-bones messaging system with user authentication using PostgreSQL, Prisma ORM, JWT tokens, and REST API.

## Features

- 🚀 **REST API** - Complete Express.js API with authentication middleware
- 🔐 **JWT Authentication** - Secure user registration and login
- 💬 **Message CRUD** - Create, read, update, and delete messages
- 🐘 **PostgreSQL** - Running in Docker for easy deployment
- 🔄 **Prisma ORM** - Type-safe database access
- 📦 **TypeScript** - Full type safety
- 🛡️ **Security** - Helmet, CORS, bcrypt password hashing

## Project Structure

```
prisma/
├── docker-compose.yml      # PostgreSQL container configuration
├── prisma/
│   ├── schema.prisma       # Database schema (User & Message models)
│   └── migrations/         # Database migration files
├── src/
│   ├── lib/
│   │   └── prisma.ts       # Prisma client instance
│   ├── auth/
│   │   ├── auth.ts         # JWT & password hashing utilities
│   │   └── user.ts         # User registration & login
│   ├── api/
│   │   └── messages.ts     # Message CRUD operations
│   ├── routes/
│   │   ├── auth.routes.ts  # Auth API endpoints
│   │   └── message.routes.ts # Message API endpoints
│   ├── middleware/
│   │   └── auth.middleware.ts # JWT authentication middleware
│   ├── server.ts           # Express API server
│   └── index.ts            # Demo application
├── .env                    # Environment variables
├── test-api.sh             # API testing script
├── API.md                  # Complete API documentation
└── package.json
```

## Prerequisites

- Node.js 18+ (for running the app)
- Docker (for PostgreSQL database)
- pnpm (package manager)

## Quick Start

### 1. Start PostgreSQL Database

```bash
pnpm docker:up
```

This starts a PostgreSQL 16 container with:
- Database: `messaging`
- User: `msguser`
- Password: `msgpass123`
- Port: `5432`

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Run Migrations

The migrations have already been run, but if you need to reset:

```bash
pnpm db:migrate
```

### 4. Start the API Server

```bash
pnpm start
```

The API will be available at `http://localhost:3000`

Or run in development mode with auto-reload:

```bash
pnpm dev
```

### 5. Test the API

Run the test script:

```bash
bash test-api.sh
```

Or run the demo application:

```bash
pnpm demo
```

## Available Commands

### Application

```bash
pnpm start            # Start the API server
pnpm dev              # Start API server with auto-reload
pnpm demo             # Run the demo application (tests all features)
```

### Database Management

```bash
pnpm db:studio        # Open Prisma Studio (GUI for your database)
pnpm db:migrate       # Create and apply a new migration
pnpm db:generate      # Regenerate Prisma Client
pnpm db:push          # Push schema changes without migration
pnpm db:reset         # Reset database (⚠️ deletes all data)
```

### Docker

```bash
pnpm docker:up        # Start PostgreSQL container
pnpm docker:down      # Stop PostgreSQL container
pnpm docker:logs      # View PostgreSQL logs
```

## REST API

The application includes a complete REST API built with Express.js.

### API Endpoints

**Base URL:** `http://localhost:3000`

#### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (requires auth)
- `GET /api/auth/users` - Get all users (requires auth)

#### Messages
- `GET /api/messages` - Get all messages
- `GET /api/messages/:id` - Get message by ID
- `GET /api/messages/user/:userId` - Get messages by user
- `POST /api/messages` - Create message (requires auth)
- `PUT /api/messages/:id` - Update message (requires auth)
- `DELETE /api/messages/:id` - Delete message (requires auth)

### Quick API Test

```bash
# 1. Register a user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","name":"Test User"}'

# 2. Login (save the token from response)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'

# 3. Create a message (replace YOUR_TOKEN with actual token)
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"content":"Hello from the API!"}'

# 4. Get all messages
curl http://localhost:3000/api/messages
```

**📚 Complete API Documentation:** See [API.md](./API.md) for detailed endpoint documentation, request/response examples, and error handling.

## API Usage Examples

### Authentication

#### Register a User

```typescript
import { registerUser } from './auth/user.js';

const result = await registerUser({
  email: 'user@example.com',
  password: 'securePassword123',
  name: 'John Doe',
});

console.log(result.token);  // JWT token
console.log(result.user);   // User info (without password)
```

#### Login

```typescript
import { loginUser } from './auth/user.js';

const result = await loginUser({
  email: 'user@example.com',
  password: 'securePassword123',
});

console.log(result.token);  // JWT token
```

#### Verify Token

```typescript
import { verifyToken } from './auth/auth.js';

const decoded = verifyToken(token);
if (decoded) {
  console.log(decoded.userId);   // User ID
  console.log(decoded.email);    // User email
}
```

### Messages

#### Create a Message

```typescript
import { createMessage } from './api/messages.js';

const message = await createMessage({
  content: 'Hello, world!',
  authorId: userId,
});
```

#### Get All Messages

```typescript
import { getAllMessages } from './api/messages.js';

const messages = await getAllMessages();
// Returns messages with author information
```

#### Get Messages by User

```typescript
import { getMessagesByUser } from './api/messages.js';

const userMessages = await getMessagesByUser(userId);
```

#### Update a Message

```typescript
import { updateMessage } from './api/messages.js';

const updated = await updateMessage(messageId, {
  content: 'Updated content',
});
```

#### Delete a Message

```typescript
import { deleteMessage } from './api/messages.js';

await deleteMessage(messageId);
```

## Database Schema

### User Model

```prisma
model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  password  String    // Hashed with bcrypt
  name      String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  messages  Message[]
}
```

### Message Model

```prisma
model Message {
  id        Int      @id @default(autoincrement())
  content   String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
}
```

## Environment Variables

Create a `.env` file (already created):

```env
DATABASE_URL="postgresql://msguser:msgpass123@localhost:5432/messaging?schema=public"
JWT_SECRET="your-super-secret-jwt-key-change-in-production-min-32-chars"
JWT_EXPIRES_IN="7d"
```

⚠️ **Important**: Change `JWT_SECRET` in production!

## Deployment

### Deploy with Docker

The `docker-compose.yml` is ready for deployment. Simply:

1. Update the PostgreSQL password in `docker-compose.yml`
2. Update the `DATABASE_URL` in `.env`
3. Update `JWT_SECRET` to a secure random string
4. Deploy to your server:

```bash
docker compose up -d
pnpm db:migrate
```

### Deploy to Cloud

For cloud PostgreSQL (Neon, Supabase, Railway):

1. Get your database connection string from the provider
2. Update `DATABASE_URL` in `.env`
3. Run migrations: `pnpm db:migrate`
4. Deploy your app to your hosting platform

## Security Considerations

### Current Implementation

- ✅ Passwords are hashed with bcrypt (10 rounds)
- ✅ JWTs are signed and verified
- ✅ Environment variables for secrets
- ✅ SQL injection protection (via Prisma)

### Production Recommendations

- 🔒 Use HTTPS only
- 🔒 Rotate JWT secrets regularly
- 🔒 Implement rate limiting
- 🔒 Add password complexity requirements
- 🔒 Implement refresh tokens
- 🔒 Add email verification
- 🔒 Implement account lockout after failed attempts
- 🔒 Use environment-specific secrets
- 🔒 Enable PostgreSQL SSL connections

## Next Steps

### Add a REST API

Use Express.js or Fastify:

```bash
pnpm add express
pnpm add -D @types/express
```

### Add GraphQL

Use Apollo Server or Pothos:

```bash
pnpm add @apollo/server graphql
```

### Add a Frontend

Use React, Vue, or any frontend framework to consume the API.

## Troubleshooting

### Database Connection Failed

1. Check if Docker is running: `docker ps`
2. Check if PostgreSQL is healthy: `pnpm docker:logs`
3. Verify DATABASE_URL in `.env`

### Prisma Client Not Found

Run:

```bash
pnpm db:generate
```

### Migration Failed

Reset the database:

```bash
pnpm db:reset
```

## License

MIT
