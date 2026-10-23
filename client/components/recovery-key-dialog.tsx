'use client';

import { Button, Code, Dialog, Stack, Text, toast } from '@commercetools/nimbus';

interface RecoveryKeyDialogProps {
  /** null keeps the dialog closed */
  recoveryKey: string | null;
  onDone: () => void;
}

export function RecoveryKeyDialog({ recoveryKey, onDone }: RecoveryKeyDialogProps) {
  const copy = async () => {
    await navigator.clipboard.writeText(recoveryKey ?? '');
    toast({ type: 'success', title: 'Copied' });
  };

  return (
    <Dialog.Root isOpen={recoveryKey !== null} isDismissable={false} isKeyboardDismissDisabled>
      <Dialog.Content width="sm">
        <Dialog.Header>
          <Dialog.Title>Save your recovery key</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <Stack direction="column" gap="400">
            <Text>
              Your messages are encrypted with keys only you hold. If you forget your password, this key is the only way
              back in. Store it somewhere safe; it is shown once.
            </Text>
            <Code size="lg" wordBreak="break-all" paddingY="200">
              {recoveryKey}
            </Code>
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="outline" onPress={copy}>
            Copy
          </Button>
          <Button variant="solid" onPress={onDone}>
            I saved it
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
