import { registerUser, loginUser, getAllUsers } from './auth/user.js';
import {
  createMessage,
  getAllMessages,
  getMessagesByUser,
  updateMessage,
  deleteMessage,
} from './api/messages.js';
import { verifyToken } from './auth/auth.js';

async function main() {
  console.log('🚀 Starting Messaging System Demo\n');

  try {
    // 1. Register first user
    console.log('1️⃣  Registering user: alice@example.com');
    const alice = await registerUser({
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    });
    console.log('✅ Alice registered:', {
      id: alice.user.id,
      email: alice.user.email,
      name: alice.user.name,
    });
    console.log('🔑 Token:', alice.token.substring(0, 50) + '...\n');

    // 2. Register second user
    console.log('2️⃣  Registering user: bob@example.com');
    const bob = await registerUser({
      email: 'bob@example.com',
      password: 'password456',
      name: 'Bob',
    });
    console.log('✅ Bob registered:', {
      id: bob.user.id,
      email: bob.user.email,
      name: bob.user.name,
    });
    console.log('\n');

    // 3. Login as Alice
    console.log('3️⃣  Logging in as Alice');
    const aliceLogin = await loginUser({
      email: 'alice@example.com',
      password: 'password123',
    });
    console.log('✅ Alice logged in successfully\n');

    // 4. Verify token
    console.log('4️⃣  Verifying Alice\'s token');
    const tokenData = verifyToken(aliceLogin.token);
    console.log('✅ Token verified:', tokenData, '\n');

    // 5. Alice creates a message
    console.log('5️⃣  Alice creates a message');
    const message1 = await createMessage({
      content: 'Hello everyone! This is my first message.',
      authorId: alice.user.id,
    });
    console.log('✅ Message created:', {
      id: message1.id,
      content: message1.content,
      author: message1.author.name,
    });
    console.log('\n');

    // 6. Bob creates messages
    console.log('6️⃣  Bob creates messages');
    await createMessage({
      content: 'Hi Alice! Welcome to the platform.',
      authorId: bob.user.id,
    });
    await createMessage({
      content: 'This is a great messaging system!',
      authorId: bob.user.id,
    });
    console.log('✅ Bob created 2 messages\n');

    // 7. Get all messages
    console.log('7️⃣  Fetching all messages');
    const allMessages = await getAllMessages();
    console.log(`✅ Found ${allMessages.length} messages:`);
    allMessages.forEach((msg) => {
      console.log(`   - ${msg.author.name}: "${msg.content}"`);
    });
    console.log('\n');

    // 8. Get Bob's messages only
    console.log('8️⃣  Fetching Bob\'s messages');
    const bobMessages = await getMessagesByUser(bob.user.id);
    console.log(`✅ Bob has ${bobMessages.length} messages\n`);

    // 9. Update a message
    console.log('9️⃣  Updating Alice\'s message');
    const updatedMessage = await updateMessage(message1.id, {
      content: 'Hello everyone! This is my updated first message.',
    });
    console.log('✅ Message updated:', updatedMessage.content, '\n');

    // 10. Get all users
    console.log('🔟 Fetching all users');
    const users = await getAllUsers();
    console.log(`✅ Found ${users.length} users:`);
    users.forEach((user) => {
      console.log(`   - ${user.name} (${user.email})`);
    });
    console.log('\n');

    // 11. Delete a message
    console.log('1️⃣1️⃣  Deleting a message');
    await deleteMessage(message1.id);
    console.log('✅ Message deleted\n');

    // 12. Final message count
    const finalMessages = await getAllMessages();
    console.log(`✅ Final message count: ${finalMessages.length}\n`);

    console.log('🎉 Demo completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
