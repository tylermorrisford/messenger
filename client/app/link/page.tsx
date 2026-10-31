'use client';

import { Alert, Box, Button, Code, Heading, Link, LoadingSpinner, Stack, Text } from '@commercetools/nimbus';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError, type DeviceLinkStatus } from '@/lib/api';
import { openFromDevice, signLinkClaim, startLink, type PendingLink } from '@/lib/crypto/device-link';

const POLL_MS = 2000;

type Status = 'starting' | 'waiting' | 'claiming' | 'expired' | 'failed';

const statusText: Record<Status, string> = {
  starting: 'Getting a code…',
  waiting: 'Waiting for the other device…',
  claiming: 'Approved. Signing in…',
  expired: 'That code expired. Codes work for five minutes.',
  failed: '',
};

export default function LinkPage() {
  const router = useRouter();
  const { user, loading, signIn } = useAuth();
  const [link, setLink] = useState<PendingLink | null>(null);
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && user) {
      router.replace('/');
    }
  }, [loading, user, router]);

  const start = useCallback(async () => {
    setError('');
    setStatus('starting');

    try {
      const { request, ...pending } = await startLink();
      await api.startDeviceLink(request);
      setLink(pending);
      setStatus('waiting');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      setStatus('failed');
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!link || status !== 'waiting') {
      return;
    }
    let cancelled = false;

    const finish = async (approved: Extract<DeviceLinkStatus, { approved: true }>) => {
      setStatus('claiming');
      try {
        const keys = await openFromDevice(link.code, link.ephemeral, approved);
        const session = await api.claimDeviceLink(link.linkId, signLinkClaim(link.linkId, keys.ed25519Priv));
        await signIn(session.user, { ...keys, userId: session.user.id, keyVersion: session.keys.version });
        router.replace('/');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not sign in on this device.');
        setStatus('failed');
      }
    };

    const poll = async () => {
      while (!cancelled) {
        let result: DeviceLinkStatus | null = null;

        try {
          result = await api.getDeviceLink(link.linkId);
        } catch (caught) {
          if (caught instanceof ApiError && !cancelled) {
            if (caught.status !== 404) {
              setError(caught.message);
            }
            setStatus(caught.status === 404 ? 'expired' : 'failed');
            return;
          }
          // the server is unreachable for the moment; the next round asks again
        }
        if (cancelled) {
          return;
        }

        if (result?.approved) {
          await finish(result);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    void poll();

    return () => {
      cancelled = true;
    };
  }, [link, status, signIn, router]);

  const showCode = link && (status === 'waiting' || status === 'claiming');

  return (
    <Box maxWidth="400px" marginX="auto" paddingX="400" paddingY="1600">
      <Stack direction="column" gap="600">
        <Heading size="lg">Link this device</Heading>
        <Text>
          On a device where you are already signed in, open the Messenger home page, find Link a device, and enter this
          code. Nothing else to type: your keys arrive sealed so only this device can open them.
        </Text>
        {showCode && (
          <Code size="lg" textAlign="center" paddingY="200" aria-label={`Code ${link.code.split('').join(' ')}`}>
            {link.code}
          </Code>
        )}
        {status === 'expired' && (
          <Alert.Root colorPalette="warning">
            <Alert.Description>{statusText.expired}</Alert.Description>
          </Alert.Root>
        )}
        {status === 'failed' && (
          <Alert.Root colorPalette="critical">
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        )}
        {(status === 'expired' || status === 'failed') ? (
          <Button variant="solid" onPress={() => void start()} alignSelf="flex-start">
            Get a new code
          </Button>
        ) : (
          <Stack direction="row" gap="300" alignItems="center" role="status">
            <LoadingSpinner aria-label="Waiting" />
            <Text color="fg.subtle">{statusText[status]}</Text>
          </Stack>
        )}
        <Text>
          <Link href="/login">Sign in with a password instead</Link>
        </Text>
      </Stack>
    </Box>
  );
}
