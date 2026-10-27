'use client';

import { Button, Code, Dialog, LoadingSpinner, Stack, Text } from '@commercetools/nimbus';
import { useEffect, useState } from 'react';
import { safetyNumber } from '@/lib/crypto/safety-number';

export interface SafetyNumbersPerson {
  name: string;
  ed25519Pub: string;
}

interface SafetyNumbersDialogProps {
  /** null keeps the dialog closed */
  person: SafetyNumbersPerson | null;
  myEd25519Pub: string;
  onClose: () => void;
}

export function SafetyNumbersDialog({ person, myEd25519Pub, onClose }: SafetyNumbersDialogProps) {
  const [number, setNumber] = useState<string | null>(null);

  useEffect(() => {
    setNumber(null);
    if (person) {
      void safetyNumber(myEd25519Pub, person.ed25519Pub).then(setNumber);
    }
  }, [person, myEd25519Pub]);

  return (
    <Dialog.Root isOpen={person !== null} isDismissable onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content width="sm">
        <Dialog.Header>
          <Dialog.Title>Safety numbers with {person?.name}</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <Stack direction="column" gap="400">
            <Text>
              Compare these digits with {person?.name} in person or on a call. If they match, nobody is sitting between
              you. If they don&apos;t, stop and ask them whether they reset their account.
            </Text>
            {number ? (
              <Code size="lg" wordBreak="break-word" paddingY="200" textAlign="center">
                {number}
              </Code>
            ) : (
              <LoadingSpinner aria-label="Computing safety numbers" />
            )}
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="solid" onPress={onClose}>
            Done
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
