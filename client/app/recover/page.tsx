'use client';

import { Alert, Box, Button, FormField, Heading, Link, PasswordInput, Stack, Text, TextInput } from '@commercetools/nimbus';
import sodium from 'libsodium-wrappers-sumo';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RecoveryKeyDialog } from '@/components/recovery-key-dialog';
import { useAuth } from '@/contexts/auth-context';
import { api, ApiError, type User } from '@/lib/api';
import { deriveKeys, KDF_DEFAULTS } from '@/lib/crypto/kdf';
import {
  formatRecoveryKey,
  generateIdentity,
  generateRecoveryKey,
  openBundle,
  parseRecoveryKey,
  sealBundle,
  signCredentials,
  toBase64,
  type IdentityKeys,
} from '@/lib/crypto/keys';

type Step = 'email' | 'code' | 'reset';

const failureMessage = (caught: unknown): string =>
  caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.';

export default function RecoverPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [proof, setProof] = useState('');
  const [sealed, setSealed] = useState({ recoveryBundle: '', recoveryBundleNonce: '' });
  const [recoveryKeyText, setRecoveryKeyText] = useState('');
  const [lostKey, setLostKey] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.sendEmailCode(email, 'RECOVER');
      setStep('code');
    });
  };

  const verifyCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const nextProof = await api.verifyEmailCode(email, 'RECOVER', code);
      setSealed(await api.getRecoveryBundle(nextProof));
      setProof(nextProof);
      setStep('reset');
    });
  };

  const finishSignIn = async (user: User, identity: IdentityKeys) => {
    const keys = await api.getUserKeys(user.id);
    await signIn(user, { ...identity, userId: user.id, keyVersion: keys.find((key) => key.retiredAt === null)?.version ?? 1 });
  };

  const recoverWithKey = async () => {
    const recoveryKey = parseRecoveryKey(recoveryKeyText);
    if (recoveryKey.length !== 32) {
      setError('That is not a complete recovery key.');
      return;
    }

    let identity: IdentityKeys;
    try {
      identity = await openBundle({ bundle: sealed.recoveryBundle, nonce: sealed.recoveryBundleNonce }, recoveryKey);
    } catch {
      setError('That recovery key does not unlock this account.');
      return;
    }

    const { authKey, encKey } = await deriveKeys(email, password, KDF_DEFAULTS);
    const keyBundle = await sealBundle(identity, encKey);
    sodium.memzero(encKey);
    const update = { authKey, kdf: KDF_DEFAULTS, keyBundle: keyBundle.bundle, keyBundleNonce: keyBundle.nonce };

    const { user } = await api.recover({ ...update, emailProof: proof, signature: signCredentials(update, identity.ed25519Priv) });
    await finishSignIn(user, identity);
    router.replace('/');
  };

  const resetIdentity = async () => {
    const [identity, recoveryBytes, { authKey, encKey }] = await Promise.all([
      generateIdentity(),
      generateRecoveryKey(),
      deriveKeys(email, password, KDF_DEFAULTS),
    ]);
    const keyBundle = await sealBundle(identity, encKey);
    const recoveryBundle = await sealBundle(identity, recoveryBytes);
    sodium.memzero(encKey);

    const { user } = await api.resetIdentity({
      emailProof: proof,
      authKey,
      kdf: KDF_DEFAULTS,
      keyBundle: keyBundle.bundle,
      keyBundleNonce: keyBundle.nonce,
      x25519Pub: toBase64(identity.x25519Pub),
      ed25519Pub: toBase64(identity.ed25519Pub),
      recoveryBundle: recoveryBundle.bundle,
      recoveryBundleNonce: recoveryBundle.nonce,
    });
    await finishSignIn(user, identity);
    setNewRecoveryKey(formatRecoveryKey(recoveryBytes));
  };

  const reset = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    void run(lostKey ? resetIdentity : recoverWithKey);
  };

  const errorAlert = error && (
    <Alert.Root colorPalette="critical">
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  );

  return (
    <Box maxWidth="400px" marginX="auto" paddingX="400" paddingY="1600">
      <Stack direction="column" gap="600">
        <Heading size="lg">Recover your account</Heading>

        {step === 'email' && (
          <form onSubmit={sendCode}>
            <Stack direction="column" gap="400">
              <Text>We will email you a code to prove it is you.</Text>
              <FormField.Root isRequired>
                <FormField.Label>Email</FormField.Label>
                <FormField.Input>
                  <TextInput type="email" autoComplete="email" value={email} onChange={setEmail} />
                </FormField.Input>
              </FormField.Root>
              {errorAlert}
              <Button type="submit" variant="solid" isDisabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </Stack>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={verifyCode}>
            <Stack direction="column" gap="400">
              <Text>Enter the 6-digit code we sent to {email}.</Text>
              <FormField.Root isRequired>
                <FormField.Label>Code</FormField.Label>
                <FormField.Input>
                  <TextInput autoComplete="one-time-code" value={code} onChange={setCode} />
                </FormField.Input>
              </FormField.Root>
              {errorAlert}
              <Button type="submit" variant="solid" isDisabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </Button>
            </Stack>
          </form>
        )}

        {step === 'reset' && (
          <form onSubmit={reset}>
            <Stack direction="column" gap="400">
              {lostKey ? (
                <Alert.Root colorPalette="warning">
                  <Alert.Title>This creates brand new keys</Alert.Title>
                  <Alert.Description>
                    Messages in your existing conversations stay unreadable, and friends will need to add you again.
                  </Alert.Description>
                </Alert.Root>
              ) : (
                <FormField.Root isRequired>
                  <FormField.Label>Recovery key</FormField.Label>
                  <FormField.Input>
                    <TextInput autoComplete="off" value={recoveryKeyText} onChange={setRecoveryKeyText} />
                  </FormField.Input>
                  <FormField.Description>The 13 groups of letters you saved when you signed up</FormField.Description>
                </FormField.Root>
              )}
              <FormField.Root isRequired>
                <FormField.Label>New password</FormField.Label>
                <FormField.Input>
                  <PasswordInput autoComplete="new-password" value={password} onChange={setPassword} />
                </FormField.Input>
              </FormField.Root>
              <FormField.Root isRequired isInvalid={confirm !== '' && confirm !== password}>
                <FormField.Label>Confirm new password</FormField.Label>
                <FormField.Input>
                  <PasswordInput autoComplete="new-password" value={confirm} onChange={setConfirm} />
                </FormField.Input>
                <FormField.Error>The passwords do not match</FormField.Error>
              </FormField.Root>
              {errorAlert}
              <Button type="submit" variant="solid" colorPalette={lostKey ? 'critical' : 'primary'} isDisabled={busy}>
                {busy ? 'Working…' : lostKey ? 'Reset my keys' : 'Set new password'}
              </Button>
              <Button variant="link" onPress={() => setLostKey((value) => !value)}>
                {lostKey ? 'I found my recovery key' : 'I lost my recovery key'}
              </Button>
            </Stack>
          </form>
        )}

        <Text>
          <Link href="/login">Back to sign in</Link>
        </Text>
      </Stack>
      <RecoveryKeyDialog recoveryKey={newRecoveryKey} onDone={() => router.replace('/')} />
    </Box>
  );
}
