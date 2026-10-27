'use client';

import { Box, Button, DefaultPage, FormField, Heading, Link, LoadingSpinner, Stack, TextInput, toast } from '@commercetools/nimbus';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError } from '@/lib/api';

export default function HomePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (!user) {
    return (
      <Box padding="1600" textAlign="center">
        <LoadingSpinner aria-label="Loading" />
      </Box>
    );
  }

  const sendInvite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      await api.createInvite(inviteEmail);
      toast({ type: 'success', title: `Invite sent to ${inviteEmail}` });
      setInviteEmail('');
    } catch (caught) {
      toast({
        type: 'error',
        title: caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DefaultPage.Root>
      <DefaultPage.Header>
        <DefaultPage.Title>Messenger</DefaultPage.Title>
        <DefaultPage.Subtitle>Signed in as {user.email}</DefaultPage.Subtitle>
        <DefaultPage.Actions>
          <Link href="/conversations">Conversations</Link>
          <Button variant="outline" onPress={() => void logout()}>
            Sign out
          </Button>
        </DefaultPage.Actions>
      </DefaultPage.Header>
      <DefaultPage.Content>
        <form onSubmit={sendInvite}>
          <Stack direction="column" gap="400" maxWidth="400px">
            <Heading size="md">Invite a friend</Heading>
            <FormField.Root isRequired>
              <FormField.Label>Their email</FormField.Label>
              <FormField.Input>
                <TextInput width="100%" type="email" value={inviteEmail} onChange={setInviteEmail} />
              </FormField.Input>
              <FormField.Description>They get a sign-up link that works for 7 days</FormField.Description>
            </FormField.Root>
            <Button type="submit" variant="solid" isDisabled={busy} alignSelf="flex-start">
              {busy ? 'Sending…' : 'Send invite'}
            </Button>
          </Stack>
        </form>
      </DefaultPage.Content>
    </DefaultPage.Root>
  );
}
