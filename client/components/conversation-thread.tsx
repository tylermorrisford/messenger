'use client';

import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  ChatMessage,
  ChatMessageList,
  DefaultPage,
  Dialog,
  Flex,
  FormField,
  Heading,
  IconButton,
  Item,
  ItemGroup,
  LoadingSpinner,
  MultilineTextInput,
  Select,
  Stack,
  Text,
  TextInput,
  toast,
  type ChatMessageListHandle,
} from '@commercetools/nimbus';
import { Fingerprint, PersonRemove, Send } from '@commercetools/nimbus-icons';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { SafetyNumbersDialog, type SafetyNumbersPerson } from '@/components/safety-numbers-dialog';
import { api, ApiError, type Conversation, type Member, type Message, type PublicProfile, type User, type UserKey } from '@/lib/api';
import { generateConversationKey, unwrapConversationKey, verifyWrappedKey, wrapConversationKey } from '@/lib/crypto/conversation';
import { toBase64 } from '@/lib/crypto/keys';
import { decryptMessage, encryptMessage } from '@/lib/crypto/message';
import {
  checkPin,
  loadConversationKeys,
  loadPin,
  saveConversationKey,
  savePin,
  type PublicKeys,
  type StoredIdentity,
  type StoredPin,
} from '@/lib/crypto/store';
import { displayName, nameParts } from '@/lib/people';
import { subscribeToEvents } from '@/lib/sse';

interface ConversationThreadProps {
  id: string;
  user: User;
  identity: StoredIdentity;
}

interface DecryptedMessage {
  id: string;
  seq: number;
  senderId: string;
  createdAt: string;
  expiresAt: string | null;
  text: string | null;
  /** set instead of text when the message could not be opened */
  problem?: string;
}

interface KeyChange {
  userId: string;
  name: string;
  pinned: StoredPin;
  current: PublicKeys;
}

type Confirmation = { kind: 'leave' } | { kind: 'remove'; member: Member };

const COUNTDOWN_TICK_MS = 30_000;

const TTL_OPTIONS: { seconds: number | null; label: string }[] = [
  { seconds: 5 * 60, label: '5 minutes' },
  { seconds: 60 * 60, label: '1 hour' },
  { seconds: 24 * 60 * 60, label: '1 day' },
  { seconds: 7 * 24 * 60 * 60, label: '1 week' },
  { seconds: 30 * 24 * 60 * 60, label: '30 days' },
  { seconds: null, label: 'Never' },
];

function ttlKey(seconds: number | null): string {
  return seconds === null ? 'never' : String(seconds);
}

function ttlLabel(seconds: number | null): string {
  return TTL_OPTIONS.find((option) => option.seconds === seconds)?.label ?? `${seconds} seconds`;
}

function timeLeft(expiresAt: string, now: number): string {
  const seconds = Math.max(0, (Date.parse(expiresAt) - now) / 1000);
  if (seconds >= 24 * 60 * 60) {
    return `${Math.floor(seconds / (24 * 60 * 60))}d`;
  }
  if (seconds >= 60 * 60) {
    return `${Math.floor(seconds / (60 * 60))}h`;
  }
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : '<1m';
}

/** The stream and a reload can both deliver the same message; the newer copy wins */
function merge(previous: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }

  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function currentKeyOf(keys: UserKey[]): PublicKeys {
  const current = keys.find((key) => key.retiredAt === null);

  if (!current) {
    throw new Error('User has no active key');
  }

  return current;
}

function errorTitle(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Could not reach the server. Try again.';
}

export function ConversationThread({ id, user, identity }: ConversationThreadProps) {
  const router = useRouter();
  const listRef = useRef<ChatMessageListHandle>(null);
  const userKeys = useRef(new Map<string, Promise<UserKey[]>>());
  /** mirrors epochKeys for the stream handler, which outlives any one render */
  const epochKeysRef = useRef(new Map<number, Uint8Array>());
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [epochKeys, setEpochKeys] = useState(new Map<number, Uint8Array>());
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [keyChanges, setKeyChanges] = useState<KeyChange[]>([]);
  const [draft, setDraft] = useState('');
  /** null sends with the conversation default */
  const [ttlOverride, setTtlOverride] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'send' | 'add' | 'rotate' | 'leave' | 'settings' | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [safetyPerson, setSafetyPerson] = useState<SafetyNumbersPerson | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const keysFor = useCallback((userId: string): Promise<UserKey[]> => {
    let keys = userKeys.current.get(userId);

    if (!keys) {
      keys = api.getUserKeys(userId);
      userKeys.current.set(userId, keys);
    }

    return keys;
  }, []);

  const open = useCallback(
    async (message: Message, keys: Map<number, Uint8Array>): Promise<DecryptedMessage> => {
      const base = {
        id: message.id,
        seq: message.seq,
        senderId: message.senderId,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt,
        text: null,
      };
      const key = keys.get(message.epoch);
      if (!key) {
        return { ...base, problem: 'Sent before you had the key' };
      }
      const sender = (await keysFor(message.senderId)).find((candidate) => candidate.version === message.senderKeyVersion);
      if (!sender) {
        return { ...base, problem: 'Unknown sender key' };
      }
      try {
        return { ...base, text: await decryptMessage(message, key, sender.ed25519Pub) };
      } catch {
        return { ...base, problem: 'Could not verify this message' };
      }
    },
    [keysFor],
  );

  const load = useCallback(async () => {
    const loaded = await api.getConversation(id);
    const others = loaded.members.filter((member) => member.userId !== user.id);
    const changes: KeyChange[] = [];
    for (const member of others) {
      const current = currentKeyOf(await keysFor(member.userId));
      const pinned = await checkPin(member.userId, current);
      if (pinned) {
        changes.push({ userId: member.userId, name: displayName(member), pinned, current });
      }
    }
    const changed = new Set(changes.map((change) => change.userId));

    const keys = new Map((await loadConversationKeys(id)).map((stored) => [stored.epoch, stored.key]));
    const served = await api.getConversationKeys(id);
    for (const row of served.mine) {
      if (keys.has(row.epoch) || row.recipientKeyVersion !== identity.keyVersion) {
        continue;
      }
      const distributor = (await keysFor(row.distributorUserId)).find((key) => key.version === row.distributorKeyVersion);
      const signed = { ...row, recipientUserId: user.id, conversationId: id };
      if (!distributor || !(await verifyWrappedKey(signed, distributor.ed25519Pub))) {
        toast({ type: 'error', title: `Ignored a key for epoch ${row.epoch}: the signature is not the distributor's` });
        continue;
      }
      const key = await unwrapConversationKey(row.wrappedKey, identity);
      await saveConversationKey({ conversationId: id, epoch: row.epoch, key });
      keys.set(row.epoch, key);
    }

    // members who joined by invite have no key yet; share the current one unless their identity is in question
    const current = keys.get(served.epoch);
    if (current) {
      for (const member of served.missing) {
        if (changed.has(member.userId)) {
          continue;
        }
        const trusted = currentKeyOf(await keysFor(member.userId));
        const recipient = { userId: member.userId, keyVersion: trusted.version, x25519Pub: trusted.x25519Pub };
        try {
          await api.addConversationKey(id, await wrapConversationKey(current, recipient, id, served.epoch, identity.ed25519Priv));
        } catch (caught) {
          // someone else shared it first
          if (!(caught instanceof ApiError && caught.status === 409)) {
            throw caught;
          }
        }
      }
    }

    const opened = await Promise.all((await api.listMessages(id, { limit: 500 })).map((message) => open(message, keys)));

    epochKeysRef.current = keys;
    setConversation(loaded);
    setKeyChanges(changes);
    setEpochKeys(keys);
    setMessages((previous) => merge(previous, opened));
  }, [id, user.id, identity, keysFor, open]);

  // the stream drives loading: syncing after each (re)connect means nothing sent while disconnected is missed
  useEffect(() => {
    const sync = () =>
      load().then(
        () => setLoadError(null),
        (caught: unknown) => {
          setLoadError(errorTitle(caught));
          // removed from the conversation or it is gone: show the error view instead of a stale thread
          if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
            setConversation(null);
          }
        },
      );

    return subscribeToEvents({
      onOpen: sync,
      onError: (caught) => setLoadError(errorTitle(caught)),
      onEvent: (event) => {
        if (event.type === 'resync' || (event.type === 'conversation' && event.conversationId === id)) {
          void sync();
        } else if (event.type === 'message' && event.message.conversationId === id) {
          if (!epochKeysRef.current.has(event.message.epoch)) {
            void sync();
            return;
          }
          open(event.message, epochKeysRef.current)
            .then((opened) => setMessages((previous) => merge(previous, [opened])))
            .catch(() => void sync());
        }
      },
    });
  }, [id, load, open]);

  useEffect(() => {
    listRef.current?.scrollToBottom();
  }, [messages.length]);

  // one timer: fires at the next expiry so hiding is on time, and at least every tick to keep the countdowns fresh
  useEffect(() => {
    const upcoming = messages.flatMap((message) => (message.expiresAt ? [Date.parse(message.expiresAt)] : [])).filter((at) => at > now);
    if (upcoming.length === 0) {
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.min(...upcoming) - now, COUNTDOWN_TICK_MS));

    return () => clearTimeout(timer);
  }, [messages, now]);

  const memberNames = new Map(conversation?.members.map((member) => [member.userId, displayName(member)]));
  const currentKey = conversation ? epochKeys.get(conversation.currentEpoch) : undefined;
  const isOwner = conversation?.members.some((member) => member.userId === user.id && member.role === 'OWNER') ?? false;
  const canSend = Boolean(conversation && currentKey && !conversation.needsRotation && busy === null);

  const send = async () => {
    const text = draft.trim();
    if (!conversation || !currentKey || !text) {
      return;
    }
    setBusy('send');

    try {
      const context = { conversationId: id, senderId: user.id, epoch: conversation.currentEpoch, ttlSeconds: ttlOverride };
      const encrypted = await encryptMessage(text, context, currentKey, identity.ed25519Priv);
      const sent = await api.sendMessage(id, {
        ...encrypted,
        epoch: conversation.currentEpoch,
        senderKeyVersion: identity.keyVersion,
        ttlSeconds: ttlOverride ?? undefined,
      });
      setMessages((previous) =>
        merge(previous, [{ id: sent.id, seq: sent.seq, senderId: user.id, createdAt: sent.createdAt, expiresAt: sent.expiresAt, text }]),
      );
      setDraft('');
    } catch (caught) {
      toast({ type: 'error', title: errorTitle(caught) });
    } finally {
      setBusy(null);
    }
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!conversation) {
      return;
    }
    setBusy('add');

    try {
      let friend: PublicProfile;
      try {
        friend = await api.findUser(email);
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 404)) {
          throw caught;
        }
        await api.inviteToConversation(id, email);
        toast({ type: 'success', title: `Invite sent to ${email}. They join when they sign up.` });
        setEmail('');
        return;
      }

      if (!currentKey) {
        toast({ type: 'error', title: 'You need the conversation key before you can add someone' });
        return;
      }
      const pinned = await checkPin(friend.id, friend.keys);
      if (pinned) {
        setKeyChanges((previous) => [
          ...previous.filter((change) => change.userId !== friend.id),
          { userId: friend.id, name: displayName(friend), pinned, current: friend.keys },
        ]);
        return;
      }
      const recipient = { userId: friend.id, keyVersion: friend.keys.version, x25519Pub: friend.keys.x25519Pub };
      await api.addMember(id, await wrapConversationKey(currentKey, recipient, id, conversation.currentEpoch, identity.ed25519Priv));
      setEmail('');
      await load();
    } catch (caught) {
      toast({ type: 'error', title: errorTitle(caught) });
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (removeUserId?: string) => {
    if (!conversation) {
      return;
    }
    const recipients = conversation.members.filter((member) => member.userId !== removeUserId);
    if (recipients.some((member) => keyChanges.some((change) => change.userId === member.userId))) {
      toast({ type: 'error', title: 'Trust or verify the changed key first' });
      return;
    }
    setBusy('rotate');

    try {
      const key = await generateConversationKey();
      const epoch = conversation.currentEpoch + 1;
      const wrappedKeys = await Promise.all(
        recipients.map(async (member) => {
          const keys =
            member.userId === user.id
              ? { version: identity.keyVersion, x25519Pub: toBase64(identity.x25519Pub) }
              : currentKeyOf(await keysFor(member.userId));
          const recipient = { userId: member.userId, keyVersion: keys.version, x25519Pub: keys.x25519Pub };

          return wrapConversationKey(key, recipient, id, epoch, identity.ed25519Priv);
        }),
      );
      const rotated = await api.rotateConversationKey(id, { expectedEpoch: conversation.currentEpoch, removeUserId, wrappedKeys });
      await saveConversationKey({ conversationId: id, epoch: rotated.epoch, key });
      await load();
    } catch (caught) {
      toast({ type: 'error', title: errorTitle(caught) });
    } finally {
      setBusy(null);
    }
  };

  const changeDefaultTtl = async (key: string | number | null) => {
    const defaultTtlSeconds = key === 'never' ? null : Number(key);
    if (!conversation || key === null || defaultTtlSeconds === conversation.defaultTtlSeconds) {
      return;
    }
    setBusy('settings');

    try {
      setConversation(await api.updateConversation(id, { defaultTtlSeconds }));
    } catch (caught) {
      toast({ type: 'error', title: errorTitle(caught) });
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    setBusy('leave');

    try {
      await api.leaveConversation(id);
      router.replace('/conversations');
    } catch (caught) {
      toast({ type: 'error', title: errorTitle(caught) });
      setBusy(null);
    }
  };

  const trustNewKey = async (change: KeyChange) => {
    await savePin({ userId: change.userId, keyVersion: change.current.version, x25519Pub: change.current.x25519Pub, ed25519Pub: change.current.ed25519Pub });
    setKeyChanges((previous) => previous.filter((other) => other.userId !== change.userId));
  };

  const showSafetyNumbers = async (member: Member) => {
    const pinned = (await loadPin(member.userId)) ?? currentKeyOf(await keysFor(member.userId));
    setSafetyPerson({ name: displayName(member), ed25519Pub: pinned.ed25519Pub });
  };

  const confirm = async () => {
    const pending = confirmation;
    setConfirmation(null);
    if (pending?.kind === 'leave') {
      await leave();
    } else if (pending?.kind === 'remove') {
      await rotate(pending.member.userId);
    }
  };

  if (!conversation) {
    return (
      <Box padding="1600" textAlign="center">
        {loadError ? (
          <Alert.Root colorPalette="critical" maxWidth="480px" marginX="auto">
            <Alert.Title>Could not open this conversation</Alert.Title>
            <Alert.Description>{loadError}</Alert.Description>
            <Alert.Actions>
              <Button size="xs" variant="outline" onPress={() => router.push('/conversations')}>
                Back to conversations
              </Button>
            </Alert.Actions>
          </Alert.Root>
        ) : (
          <LoadingSpinner aria-label="Loading conversation" />
        )}
      </Box>
    );
  }

  const others = conversation.members.filter((member) => member.userId !== user.id);
  const title = conversation.title ?? (others.length > 0 ? others.map(displayName).join(', ') : 'Just you');
  const visible = messages.filter((message) => message.expiresAt === null || Date.parse(message.expiresAt) > now);

  return (
    <DefaultPage.Root height="100vh">
      <DefaultPage.Header>
        <DefaultPage.BackLink href="/conversations">Conversations</DefaultPage.BackLink>
        <DefaultPage.Title>{title}</DefaultPage.Title>
        <DefaultPage.Subtitle>End-to-end encrypted · key epoch {conversation.currentEpoch}</DefaultPage.Subtitle>
        <DefaultPage.Actions>
          <Button variant="outline" isDisabled={busy !== null} onPress={() => setConfirmation({ kind: 'leave' })}>
            Leave
          </Button>
        </DefaultPage.Actions>
      </DefaultPage.Header>
      <DefaultPage.Content>
        <Flex direction={{ base: 'column', md: 'row' }} gap="600" height="100%" justifyContent="center">
          <Flex direction="column" gap="400" flex="1" minHeight="0" minWidth="0" maxWidth="800px">
            {keyChanges.map((change) => (
              <Alert.Root key={change.userId} colorPalette="warning">
                <Alert.Title>{change.name}&apos;s identity key changed</Alert.Title>
                <Alert.Description>
                  Their key is not the one you trusted before. If they told you they reset their account, trust the new
                  key. Otherwise compare safety numbers with them first. Until then, no conversation key is shared with
                  them.
                </Alert.Description>
                <Alert.Actions>
                  <Button size="xs" variant="outline" onPress={() => void trustNewKey(change)}>
                    Trust new key
                  </Button>
                </Alert.Actions>
              </Alert.Root>
            ))}
            {conversation.needsRotation && (
              <Alert.Root colorPalette="warning">
                <Alert.Title>Someone left</Alert.Title>
                <Alert.Description>Messages are paused until a member issues a new key that the person who left cannot read.</Alert.Description>
                <Alert.Actions>
                  <Button size="xs" variant="solid" isDisabled={busy !== null} onPress={() => void rotate()}>
                    {busy === 'rotate' ? 'Rotating…' : 'Issue a new key'}
                  </Button>
                </Alert.Actions>
              </Alert.Root>
            )}
            {!currentKey && (
              <Alert.Root colorPalette="info">
                <Alert.Title>Waiting for the conversation key</Alert.Title>
                <Alert.Description>A member shares it with you the next time they open this conversation.</Alert.Description>
              </Alert.Root>
            )}

            <ChatMessageList.Root
              ref={listRef}
              aria-label={`Messages in ${title}`}
              flex="1"
              minHeight="0"
              border="solid-25"
              borderColor="neutral.6"
              borderRadius="300"
              emptyState={<Text color="fg.subtle">No messages yet. Say hi.</Text>}
            >
              {visible.map((message) => {
                const mine = message.senderId === user.id;
                const sender = conversation.members.find((member) => member.userId === message.senderId);
                const senderName = mine ? 'you' : (memberNames.get(message.senderId) ?? 'a former member');

                return (
                  <ChatMessageList.Item key={message.id}>
                    <ChatMessage.Root
                      sender={mine ? 'user' : 'agent'}
                      tone={message.problem ? 'error' : 'neutral'}
                      aria-label={`Message from ${senderName}`}
                      marginInlineStart={mine ? 'auto' : undefined}
                    >
                      <ChatMessage.Avatar {...(sender ? nameParts(sender) : {})} />
                      <ChatMessage.Body>
                        <Text whiteSpace="pre-wrap">{message.text ?? message.problem}</Text>
                      </ChatMessage.Body>
                      <ChatMessage.Meta>
                        <Flex gap="200" alignItems="center">
                          <Text textStyle="xs" color="fg.subtle">
                            {new Date(message.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </Text>
                          {message.expiresAt && (
                            <Badge size="2xs" colorPalette="neutral">
                              Disappears in {timeLeft(message.expiresAt, now)}
                            </Badge>
                          )}
                        </Flex>
                      </ChatMessage.Meta>
                    </ChatMessage.Root>
                  </ChatMessageList.Item>
                );
              })}
            </ChatMessageList.Root>

            <Flex gap="200" alignItems="flex-end">
              <Select.Root
                aria-label="This message disappears after"
                selectedKey={ttlOverride === null ? 'default' : String(ttlOverride)}
                onSelectionChange={(key) => setTtlOverride(key === null || key === 'default' ? null : Number(key))}
                isDisabled={!canSend}
              >
                <Select.Options>
                  <Select.Option id="default">Default ({ttlLabel(conversation.defaultTtlSeconds)})</Select.Option>
                  {TTL_OPTIONS.filter((option) => option.seconds !== null).map((option) => (
                    <Select.Option key={option.label} id={ttlKey(option.seconds)}>
                      {option.label}
                    </Select.Option>
                  ))}
                </Select.Options>
              </Select.Root>
              <Box flex="1">
                <MultilineTextInput
                  aria-label="Message"
                  width="100%"
                  placeholder={canSend ? 'Write a message' : 'Messages are paused'}
                  value={draft}
                  onChange={setDraft}
                  autoGrow
                  rows={1}
                  maxHeight="160px"
                  isDisabled={!canSend}
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter keeps the newline
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
              </Box>
              <IconButton
                aria-label="Send"
                variant="solid"
                colorPalette="primary"
                isDisabled={!canSend || draft.trim() === ''}
                onPress={() => void send()}
              >
                <Send />
              </IconButton>
            </Flex>
          </Flex>

          <Stack direction="column" gap="600" width={{ base: '100%', md: '280px' }} flexShrink="0">
            <Stack direction="column" gap="200">
              <Heading size="sm">Members</Heading>
              <ItemGroup.Root aria-label="Members">
                {conversation.members.map((member, index) => {
                  const self = member.userId === user.id;

                  return (
                    <Fragment key={member.userId}>
                      {index > 0 && <ItemGroup.Separator />}
                      <Item.Root size="sm">
                        <Item.Media>
                          <Avatar {...nameParts(member)} size="xs" />
                        </Item.Media>
                        <Item.Content>
                          <Item.Title>
                            {displayName(member)}
                            {self && ' (you)'}
                          </Item.Title>
                          <Item.Description>
                            {member.role === 'OWNER' ? (
                              <Badge size="2xs" colorPalette="primary">
                                Owner
                              </Badge>
                            ) : (
                              member.email
                            )}
                          </Item.Description>
                        </Item.Content>
                        {!self && (
                          <Item.Actions>
                            <IconButton
                              aria-label={`Safety numbers with ${displayName(member)}`}
                              size="xs"
                              variant="ghost"
                              onPress={() => void showSafetyNumbers(member)}
                            >
                              <Fingerprint />
                            </IconButton>
                            {isOwner && (
                              <IconButton
                                aria-label={`Remove ${displayName(member)}`}
                                size="xs"
                                variant="ghost"
                                isDisabled={busy !== null}
                                onPress={() => setConfirmation({ kind: 'remove', member })}
                              >
                                <PersonRemove />
                              </IconButton>
                            )}
                          </Item.Actions>
                        )}
                      </Item.Root>
                    </Fragment>
                  );
                })}
              </ItemGroup.Root>
            </Stack>

            <FormField.Root size="sm">
              <FormField.Label>Messages disappear after</FormField.Label>
              <FormField.Input>
                <Select.Root
                  aria-label="Messages disappear after"
                  width="100%"
                  selectedKey={ttlKey(conversation.defaultTtlSeconds)}
                  onSelectionChange={(key) => void changeDefaultTtl(key)}
                  isDisabled={busy !== null}
                >
                  <Select.Options>
                    {TTL_OPTIONS.map((option) => (
                      <Select.Option key={option.label} id={ttlKey(option.seconds)}>
                        {option.label}
                      </Select.Option>
                    ))}
                  </Select.Options>
                </Select.Root>
              </FormField.Input>
              <FormField.Description>Applies to new messages from everyone.</FormField.Description>
            </FormField.Root>

            <form onSubmit={addMember}>
              <Stack direction="column" gap="300">
                <FormField.Root isRequired size="sm">
                  <FormField.Label>Add someone</FormField.Label>
                  <FormField.Input>
                    <TextInput width="100%" type="email" value={email} onChange={setEmail} placeholder="friend@example.com" />
                  </FormField.Input>
                  <FormField.Description>They can read messages back to the last key change.</FormField.Description>
                </FormField.Root>
                <Button type="submit" size="sm" variant="outline" isDisabled={busy !== null} alignSelf="flex-start">
                  {busy === 'add' ? 'Adding…' : 'Add'}
                </Button>
              </Stack>
            </form>
          </Stack>
        </Flex>
      </DefaultPage.Content>

      <SafetyNumbersDialog person={safetyPerson} myEd25519Pub={toBase64(identity.ed25519Pub)} onClose={() => setSafetyPerson(null)} />

      <Dialog.Root isOpen={confirmation !== null} isDismissable onOpenChange={(open) => !open && setConfirmation(null)}>
        <Dialog.Content width="sm">
          <Dialog.Header>
            <Dialog.Title>{confirmation?.kind === 'remove' ? `Remove ${displayName(confirmation.member)}?` : 'Leave this conversation?'}</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Text>
              {confirmation?.kind === 'remove'
                ? 'Everyone else gets a new key they cannot read. Messages sent so far stay with them.'
                : 'You will need someone to add you again to come back. Messages pause for everyone until a member issues a new key.'}
            </Text>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="outline" onPress={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button variant="solid" colorPalette="critical" onPress={() => void confirm()}>
              {confirmation?.kind === 'remove' ? 'Remove' : 'Leave'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </DefaultPage.Root>
  );
}
