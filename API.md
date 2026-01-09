# Messaging API Documentation

Base URL: `http://localhost:3000`

## Table of Contents

- [Authentication](#authentication)
- [Auth Endpoints](#auth-endpoints)
- [Message Endpoints](#message-endpoints)
- [Error Handling](#error-handling)
- [Examples](#examples)

## Authentication

This API uses JWT (JSON Web Tokens) for authentication.

### Getting a Token

1. Register a new user or login
2. The response will include a `token` field
3. Include this token in the `Authorization` header for protected endpoints

**Header format:**
```
Authorization: Bearer <your-token-here>
```

### Token Expiration

Tokens expire after 7 days (configurable in `.env` via `JWT_EXPIRES_IN`)

---

## Auth Endpoints

### Register User

Create a new user account.

**Endpoint:** `POST /api/auth/register`

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe" // optional
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

**Error Responses:**
- `400` - Validation error (missing email/password, password too short)
- `400` - User already exists

---

### Login

Authenticate and receive a JWT token.

**Endpoint:** `POST /api/auth/login`

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

**Error Responses:**
- `400` - Missing email or password
- `401` - Invalid credentials

---

### Get Current User

Get the authenticated user's information.

**Endpoint:** `GET /api/auth/me`

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2026-01-09T17:00:00.000Z"
  }
}
```

**Error Responses:**
- `401` - No token provided or invalid token
- `404` - User not found

---

### Get All Users

Get a list of all registered users (requires authentication).

**Endpoint:** `GET /api/auth/users`

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "email": "user1@example.com",
      "name": "User One",
      "createdAt": "2026-01-09T17:00:00.000Z"
    },
    {
      "id": 2,
      "email": "user2@example.com",
      "name": "User Two",
      "createdAt": "2026-01-09T17:05:00.000Z"
    }
  ]
}
```

**Error Responses:**
- `401` - Not authenticated

---

## Message Endpoints

### Get All Messages

Retrieve all messages with author information.

**Endpoint:** `GET /api/messages`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "content": "Hello, world!",
      "createdAt": "2026-01-09T17:00:00.000Z",
      "updatedAt": "2026-01-09T17:00:00.000Z",
      "authorId": 1,
      "author": {
        "id": 1,
        "email": "user@example.com",
        "name": "John Doe"
      }
    }
  ]
}
```

---

### Get Message by ID

Retrieve a specific message.

**Endpoint:** `GET /api/messages/:id`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "content": "Hello, world!",
    "createdAt": "2026-01-09T17:00:00.000Z",
    "updatedAt": "2026-01-09T17:00:00.000Z",
    "authorId": 1,
    "author": {
      "id": 1,
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

**Error Responses:**
- `400` - Invalid message ID
- `404` - Message not found

---

### Get Messages by User

Retrieve all messages created by a specific user.

**Endpoint:** `GET /api/messages/user/:userId`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "content": "Hello, world!",
      "createdAt": "2026-01-09T17:00:00.000Z",
      "updatedAt": "2026-01-09T17:00:00.000Z",
      "authorId": 1,
      "author": {
        "id": 1,
        "email": "user@example.com",
        "name": "John Doe"
      }
    }
  ]
}
```

**Error Responses:**
- `400` - Invalid user ID

---

### Create Message

Create a new message (requires authentication).

**Endpoint:** `POST /api/messages`

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "content": "This is my message"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "content": "This is my message",
    "createdAt": "2026-01-09T17:00:00.000Z",
    "updatedAt": "2026-01-09T17:00:00.000Z",
    "authorId": 1,
    "author": {
      "id": 1,
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

**Error Responses:**
- `400` - Missing or invalid content
- `400` - Content too long (max 5000 characters)
- `401` - Not authenticated

---

### Update Message

Update an existing message (requires authentication and ownership).

**Endpoint:** `PUT /api/messages/:id`

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "content": "Updated message content"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "content": "Updated message content",
    "createdAt": "2026-01-09T17:00:00.000Z",
    "updatedAt": "2026-01-09T17:05:00.000Z",
    "authorId": 1,
    "author": {
      "id": 1,
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

**Error Responses:**
- `400` - Invalid message ID or content
- `401` - Not authenticated
- `403` - Not the message owner
- `404` - Message not found

---

### Delete Message

Delete a message (requires authentication and ownership).

**Endpoint:** `DELETE /api/messages/:id`

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Message deleted successfully"
}
```

**Error Responses:**
- `400` - Invalid message ID
- `401` - Not authenticated
- `403` - Not the message owner
- `404` - Message not found

---

## Error Handling

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error message description"
}
```

### Common HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (authentication required)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

---

## Examples

### Complete Flow Example

#### 1. Register

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securePass123",
    "name": "John Doe"
  }'
```

#### 2. Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securePass123"
  }'
```

Save the `token` from the response.

#### 3. Create Message

```bash
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "content": "Hello from the API!"
  }'
```

#### 4. Get All Messages

```bash
curl -X GET http://localhost:3000/api/messages
```

#### 5. Update Message

```bash
curl -X PUT http://localhost:3000/api/messages/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "content": "Updated message content"
  }'
```

#### 6. Delete Message

```bash
curl -X DELETE http://localhost:3000/api/messages/1 \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

### JavaScript/TypeScript Example

```typescript
// Register or Login
const authResponse = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    email: 'john@example.com',
    password: 'securePass123',
  }),
});

const { data } = await authResponse.json();
const token = data.token;

// Create a message
const messageResponse = await fetch('http://localhost:3000/api/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    content: 'Hello from JavaScript!',
  }),
});

const message = await messageResponse.json();
console.log(message);
```

---

### Python Example

```python
import requests

# Login
response = requests.post('http://localhost:3000/api/auth/login', json={
    'email': 'john@example.com',
    'password': 'securePass123'
})

token = response.json()['data']['token']

# Create message
message_response = requests.post(
    'http://localhost:3000/api/messages',
    headers={'Authorization': f'Bearer {token}'},
    json={'content': 'Hello from Python!'}
)

print(message_response.json())
```

---

## Rate Limiting

Currently, there is no rate limiting implemented. For production use, consider adding rate limiting middleware like `express-rate-limit`.

## CORS

CORS is currently enabled for all origins. For production, configure CORS to only allow specific domains:

```typescript
app.use(cors({
  origin: ['https://yourdomain.com'],
  credentials: true,
}));
```

## Security Recommendations

1. **HTTPS Only** - Always use HTTPS in production
2. **Secure JWT Secret** - Use a strong, random JWT_SECRET (min 32 characters)
3. **Environment Variables** - Never commit `.env` to version control
4. **Rate Limiting** - Add rate limiting to prevent abuse
5. **Input Validation** - Additional validation beyond what's implemented
6. **Helmet** - Already included for security headers
7. **CORS** - Configure for specific domains in production

---

## Testing

Run the included test script:

```bash
bash test-api.sh
```

This will test all endpoints and verify the complete flow.
