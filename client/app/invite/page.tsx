'use client';

import { Alert, Box, Button, FormField, Heading, LoadingSpinner, PasswordInput, Stack, Text, TextInput } from '@commercetools/nimbus';
import sodium from 'libsodium-wrappers-sumo';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { RecoveryKeyDialog } from '@/components/recovery-key-dialog';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError } from '@/lib/api';
import { deriveKeys, KDF_DEFAULTS } from '@/lib/crypto/kdf';
import { formatRecoveryKey, generateIdentity, generateRecoveryKey, sealBundle, toBase64 } from '@/lib/crypto/keys';

export default function InvitePage() {
  // useSearchParams needs a Suspense boundary under static export
  return (
    <Suspense>
      <SignUp />
    </Suspense>
  );
}

function SignUp() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const { signIn } = useAuth();
  const [invite, setInvite] = useState<{ email: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setInviteError('This invite link is missing its token.');
      return;
    }

    api
      .getInvite(token)
      .then(setInvite)
      .catch((caught: unknown) =>
        setInviteError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.'),
      );
  }, [token]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!invite || !token) {
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setError('');
    setBusy(true);

    try {
      const [identity, recoveryBytes, { authKey, encKey }] = await Promise.all([
        generateIdentity(),
        generateRecoveryKey(),
        deriveKeys(invite.email, password, KDF_DEFAULTS),
      ]);
      const keyBundle = await sealBundle(identity, encKey);
      const recoveryBundle = await sealBundle(identity, recoveryBytes);
      sodium.memzero(encKey);

      const { user } = await api.register({
        email: invite.email,
        name: name.trim() || undefined,
        authKey,
        kdf: KDF_DEFAULTS,
        x25519Pub: toBase64(identity.x25519Pub),
        ed25519Pub: toBase64(identity.ed25519Pub),
        keyBundle: keyBundle.bundle,
        keyBundleNonce: keyBundle.nonce,
        recoveryBundle: recoveryBundle.bundle,
        recoveryBundleNonce: recoveryBundle.nonce,
        inviteToken: token,
      });

      await signIn(user, { ...identity, userId: user.id, keyVersion: 1 });
      setRecoveryKey(formatRecoveryKey(recoveryBytes));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
      setBusy(false);
    }
  };

  return (
    <Box maxWidth="400px" marginX="auto" paddingX="400" paddingY="1600">
      <Stack direction="column" gap="600">
        <Heading size="lg">Create your account</Heading>
        {inviteError && (
          <Alert.Root colorPalette="critical">
            <Alert.Description>{inviteError}</Alert.Description>
          </Alert.Root>
        )}
        {!invite && !inviteError && <LoadingSpinner aria-label="Checking your invite" />}
        {invite && (
          <form onSubmit={handleSubmit}>
            <Stack direction="column" gap="400">
              <Text>
                Signing up as <strong>{invite.email}</strong>
              </Text>
              <FormField.Root>
                <FormField.Label>Name</FormField.Label>
                <FormField.Input>
                  <TextInput width="100%" autoComplete="name" value={name} onChange={setName} />
                </FormField.Input>
                <FormField.Description>Shown to your friends</FormField.Description>
              </FormField.Root>
              <FormField.Root isRequired>
                <FormField.Label>Password</FormField.Label>
                <FormField.Input>
                  <PasswordInput width="100%" autoComplete="new-password" value={password} onChange={setPassword} />
                </FormField.Input>
                <FormField.Description>Your keys are derived from it, so nobody can reset it for you</FormField.Description>
              </FormField.Root>
              <FormField.Root isRequired isInvalid={confirm !== '' && confirm !== password}>
                <FormField.Label>Confirm password</FormField.Label>
                <FormField.Input>
                  <PasswordInput width="100%" autoComplete="new-password" value={confirm} onChange={setConfirm} />
                </FormField.Input>
                <FormField.Error>The passwords do not match</FormField.Error>
              </FormField.Root>
              {error && (
                <Alert.Root colorPalette="critical">
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Root>
              )}
              <Button type="submit" variant="solid" isDisabled={busy}>
                {busy ? 'Creating your keys…' : 'Create account'}
              </Button>
            </Stack>
          </form>
        )}
      </Stack>
      <RecoveryKeyDialog recoveryKey={recoveryKey} onDone={() => router.replace('/')} />
    </Box>
  );
}
