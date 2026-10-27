'use client';

import {
  Avatar,
  Badge,
  Box,
  Button,
  DefaultPage,
  FormField,
  Heading,
  Item,
  ItemGroup,
  LoadingSpinner,
  Stack,
  Text,
  TextInput,
  toast,
} from '@commercetools/nimbus';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Conversation, type PublicProfile, type User } from '@/lib/api';
import { generateConversationKey, wrapConversationKey } from '@/lib/crypto/conversation';
import { toBase64 } from '@/lib/crypto/keys';
import { checkPin, saveConversationKey, type StoredIdentity } from '@/lib/crypto/store';
import { displayName, nameParts } from '@/lib/people';

interface ConversationListProps {
  user: User;
  identity: StoredIdentity;
}

export function ConversationList({ user, identity }: ConversationListProps) {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listConversations()
      .then(setConversations)
      .catch((caught: unknown) =>
        toast({ type: 'error', title: caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.' }),
      );
  }, []);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      let friend: PublicProfile | null = null;
      try {
        friend = await api.findUser(email);
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 404)) {
          throw caught;
        }
      }

      const id = crypto.randomUUID();
      const key = await generateConversationKey();
      const me = { userId: user.id, keyVersion: identity.keyVersion, x25519Pub: toBase64(identity.x25519Pub) };
      const { recipientUserId: _mine, ...myKey } = await wrapConversationKey(key, me, id, 1, identity.ed25519Priv);
      await api.createConversation({ id, key: myKey });
      await saveConversationKey({ conversationId: id, epoch: 1, key });

      if (!friend) {
        await api.inviteToConversation(id, email);
        toast({ type: 'success', title: `Invite sent to ${email}. They join when they sign up.` });
      } else if (await checkPin(friend.id, friend.keys)) {
        toast({ type: 'error', title: `${displayName(friend)}'s identity key changed. Verify it from the conversation before adding them.` });
      } else {
        const theirs = { userId: friend.id, keyVersion: friend.keys.version, x25519Pub: friend.keys.x25519Pub };
        await api.addMember(id, await wrapConversationKey(key, theirs, id, 1, identity.ed25519Priv));
      }

      router.push(`/conversations?id=${id}`);
    } catch (caught) {
      toast({ type: 'error', title: caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (conversation: Conversation) => {
    const others = conversation.members.filter((member) => member.userId !== user.id);

    return conversation.title ?? (others.length > 0 ? others.map(displayName).join(', ') : 'Just you');
  };

  return (
    <DefaultPage.Root layout="flexible">
      <DefaultPage.Header>
        <DefaultPage.BackLink href="/">Home</DefaultPage.BackLink>
        <DefaultPage.Title>Conversations</DefaultPage.Title>
        <DefaultPage.Subtitle>Signed in as {user.email}</DefaultPage.Subtitle>
      </DefaultPage.Header>
      <DefaultPage.Content>
        <Stack direction="column" gap="800" maxWidth="640px">
          <form onSubmit={start}>
            <Stack direction="column" gap="400" maxWidth="400px">
              <Heading size="md">Start a conversation</Heading>
              <FormField.Root isRequired>
                <FormField.Label>Their email</FormField.Label>
                <FormField.Input>
                  <TextInput width="100%" type="email" value={email} onChange={setEmail} />
                </FormField.Input>
                <FormField.Description>Friends who already use Messenger join right away. Anyone else gets an invite.</FormField.Description>
              </FormField.Root>
              <Button type="submit" variant="solid" isDisabled={busy} alignSelf="flex-start">
                {busy ? 'Starting…' : 'Start'}
              </Button>
            </Stack>
          </form>

          {conversations === null ? (
            <Box padding="800" textAlign="center">
              <LoadingSpinner aria-label="Loading conversations" />
            </Box>
          ) : conversations.length === 0 ? (
            <Text color="fg.subtle">No conversations yet.</Text>
          ) : (
            <ItemGroup.Root aria-label="Your conversations">
              {conversations.map((conversation, index) => {
                const others = conversation.members.filter((member) => member.userId !== user.id);
                const avatarOf = others[0] ?? user;

                return (
                  <Fragment key={conversation.id}>
                    {index > 0 && <ItemGroup.Separator />}
                    <Item.Root href={`/conversations?id=${conversation.id}`} size="md">
                      <Item.Media>
                        <Avatar {...nameParts(avatarOf)} size="md" />
                      </Item.Media>
                      <Item.Content>
                        <Item.Title>{titleOf(conversation)}</Item.Title>
                        <Item.Description>
                          {conversation.members.length} {conversation.members.length === 1 ? 'member' : 'members'}
                        </Item.Description>
                      </Item.Content>
                      {conversation.needsRotation && (
                        <Item.Actions>
                          <Badge size="xs" colorPalette="warning">
                            Needs a new key
                          </Badge>
                        </Item.Actions>
                      )}
                    </Item.Root>
                  </Fragment>
                );
              })}
            </ItemGroup.Root>
          )}
        </Stack>
      </DefaultPage.Content>
    </DefaultPage.Root>
  );
}
