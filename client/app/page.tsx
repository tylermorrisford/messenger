'use client';

import { Box, Button, DefaultPage, FormField, Heading, Link, LoadingSpinner, Stack, Text, TextInput, toast } from '@commercetools/nimbus';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError } from '@/lib/api';
import { linkIdFor, sealForDevice, verifyLinkingDevice } from '@/lib/crypto/device-link';

const failureMessage = (caught: unknown): string =>
  caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.';

export default function HomePage() {
  const router = useRouter();
  const { user, identity, loading, logout } = useAuth();
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (!user || !identity) {
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
      toast({ type: 'error', title: failureMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const approveLink = async (event: FormEvent) => {
    event.preventDefault();
    setLinking(true);

    try {
      const linkId = await linkIdFor(linkCode);
      const device = await api.getLinkingDevice(linkId);

      if (!(await verifyLinkingDevice(linkCode, device.ephemeralPub, device.mac))) {
        toast({ type: 'error', title: 'That code does not match the device asking to link. Check it and try again.' });
        return;
      }

      await api.approveDeviceLink(linkId, await sealForDevice(identity, linkCode, device.ephemeralPub));
      toast({ type: 'success', title: 'Approved. Your other device is signing in.' });
      setLinkCode('');
    } catch (caught) {
      toast({ type: 'error', title: failureMessage(caught) });
    } finally {
      setLinking(false);
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
        <Stack direction="column" gap="1000" maxWidth="400px">
          <form onSubmit={sendInvite}>
            <Stack direction="column" gap="400">
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
          <form onSubmit={approveLink}>
            <Stack direction="column" gap="400">
              <Heading size="md">Link a device</Heading>
              <Text>Open Messenger on the new device, choose Link this one on the sign-in page, and enter the code it shows.</Text>
              <FormField.Root isRequired>
                <FormField.Label>Code from the new device</FormField.Label>
                <FormField.Input>
                  <TextInput width="100%" autoComplete="off" value={linkCode} onChange={setLinkCode} />
                </FormField.Input>
                <FormField.Description>Your keys go to that device sealed so only it can open them</FormField.Description>
              </FormField.Root>
              <Button type="submit" variant="solid" isDisabled={linking} alignSelf="flex-start">
                {linking ? 'Approving…' : 'Approve'}
              </Button>
            </Stack>
          </form>
        </Stack>
      </DefaultPage.Content>
    </DefaultPage.Root>
  );
}
