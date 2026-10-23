'use client';

import { Alert, Box, Button, FormField, Heading, Link, PasswordInput, Stack, Text, TextInput } from '@commercetools/nimbus';
import sodium from 'libsodium-wrappers-sumo';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError } from '@/lib/api';
import { deriveKeys } from '@/lib/crypto/kdf';
import { openBundle } from '@/lib/crypto/keys';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace('/');
    }
  }, [loading, user, router]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const kdf = await api.getKdfParams(email);
      const { authKey, encKey } = await deriveKeys(email, password, kdf);
      const result = await api.login(email, authKey);
      const keys = await openBundle({ bundle: result.keyBundle, nonce: result.keyBundleNonce }, encKey);
      sodium.memzero(encKey);

      await signIn(result.user, { ...keys, userId: result.user.id, keyVersion: result.keys.version });
      router.replace('/');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      setBusy(false);
    }
  };

  return (
    <Box maxWidth="400px" marginX="auto" paddingX="400" paddingY="1600">
      <Stack direction="column" gap="600">
        <Heading size="lg">Sign in</Heading>
        <form onSubmit={handleSubmit}>
          <Stack direction="column" gap="400">
            <FormField.Root isRequired>
              <FormField.Label>Email</FormField.Label>
              <FormField.Input>
                <TextInput type="email" autoComplete="email" value={email} onChange={setEmail} />
              </FormField.Input>
            </FormField.Root>
            <FormField.Root isRequired>
              <FormField.Label>Password</FormField.Label>
              <FormField.Input>
                <PasswordInput autoComplete="current-password" value={password} onChange={setPassword} />
              </FormField.Input>
            </FormField.Root>
            {error && (
              <Alert.Root colorPalette="critical">
                <Alert.Description>{error}</Alert.Description>
              </Alert.Root>
            )}
            <Button type="submit" variant="solid" isDisabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </Stack>
        </form>
        <Text>
          <Link href="/recover">Forgot your password?</Link>
        </Text>
        <Text color="fg.subtle">New here? Ask a friend who uses Messenger for an invite.</Text>
      </Stack>
    </Box>
  );
}
