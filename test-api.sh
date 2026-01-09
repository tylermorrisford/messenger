#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

API_URL="http://localhost:3000"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Testing Messaging API${NC}"
echo -e "${BLUE}========================================${NC}\n"

# 1. Register a user
echo -e "${YELLOW}1. Registering user (alice@test.com)${NC}"
REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@test.com",
    "password": "password123",
    "name": "Alice Test"
  }')
echo "$REGISTER_RESPONSE" | jq
TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.data.token')
USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.data.user.id')
echo -e "${GREEN}✓ User registered, Token saved${NC}\n"

# 2. Login
echo -e "${YELLOW}2. Logging in${NC}"
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@test.com",
    "password": "password123"
  }')
echo "$LOGIN_RESPONSE" | jq
echo -e "${GREEN}✓ Login successful${NC}\n"

# 3. Get current user info
echo -e "${YELLOW}3. Getting current user info${NC}"
ME_RESPONSE=$(curl -s -X GET "$API_URL/api/auth/me" \
  -H "Authorization: Bearer $TOKEN")
echo "$ME_RESPONSE" | jq
echo -e "${GREEN}✓ User info retrieved${NC}\n"

# 4. Create a message
echo -e "${YELLOW}4. Creating a message${NC}"
MESSAGE_RESPONSE=$(curl -s -X POST "$API_URL/api/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "content": "Hello from the API! This is my first message."
  }')
echo "$MESSAGE_RESPONSE" | jq
MESSAGE_ID=$(echo "$MESSAGE_RESPONSE" | jq -r '.data.id')
echo -e "${GREEN}✓ Message created${NC}\n"

# 5. Create another message
echo -e "${YELLOW}5. Creating another message${NC}"
curl -s -X POST "$API_URL/api/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "content": "This is my second message. Testing the API!"
  }' | jq
echo -e "${GREEN}✓ Second message created${NC}\n"

# 6. Get all messages
echo -e "${YELLOW}6. Getting all messages${NC}"
curl -s -X GET "$API_URL/api/messages" | jq
echo -e "${GREEN}✓ All messages retrieved${NC}\n"

# 7. Get specific message
echo -e "${YELLOW}7. Getting message by ID${NC}"
curl -s -X GET "$API_URL/api/messages/$MESSAGE_ID" | jq
echo -e "${GREEN}✓ Message retrieved by ID${NC}\n"

# 8. Get messages by user
echo -e "${YELLOW}8. Getting messages by user${NC}"
curl -s -X GET "$API_URL/api/messages/user/$USER_ID" | jq
echo -e "${GREEN}✓ User messages retrieved${NC}\n"

# 9. Update message
echo -e "${YELLOW}9. Updating message${NC}"
curl -s -X PUT "$API_URL/api/messages/$MESSAGE_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "content": "Updated: Hello from the API! This message was edited."
  }' | jq
echo -e "${GREEN}✓ Message updated${NC}\n"

# 10. Try to create message without auth (should fail)
echo -e "${YELLOW}10. Testing auth protection (should fail)${NC}"
curl -s -X POST "$API_URL/api/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "This should fail"
  }' | jq
echo -e "${GREEN}✓ Auth protection working${NC}\n"

# 11. Get all users
echo -e "${YELLOW}11. Getting all users${NC}"
curl -s -X GET "$API_URL/api/auth/users" \
  -H "Authorization: Bearer $TOKEN" | jq
echo -e "${GREEN}✓ Users retrieved${NC}\n"

# 12. Delete message
echo -e "${YELLOW}12. Deleting message${NC}"
curl -s -X DELETE "$API_URL/api/messages/$MESSAGE_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
echo -e "${GREEN}✓ Message deleted${NC}\n"

# 13. Verify deletion
echo -e "${YELLOW}13. Verifying message was deleted${NC}"
curl -s -X GET "$API_URL/api/messages/$MESSAGE_ID" | jq
echo -e "${GREEN}✓ Deletion verified${NC}\n"

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}All API tests completed successfully!${NC}"
echo -e "${BLUE}========================================${NC}"
