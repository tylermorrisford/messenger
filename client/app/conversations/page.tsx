'use client';

import { Box, LoadingSpinner } from '@commercetools/nimbus';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { ConversationList } from '@/components/conversation-list';
import { ConversationThread } from '@/components/conversation-thread';
import { useAuth } from '@/contexts/auth-context';

export default function ConversationsPage() {
  // useSearchParams needs a Suspense boundary under static export
  return (
    <Suspense>
      <Conversations />
    </Suspense>
  );
}

function Conversations() {
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { user, identity, loading } = useAuth();

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

  // the key resets thread state when switching conversations through the list
  return id ? <ConversationThread key={id} id={id} user={user} identity={identity} /> : <ConversationList user={user} identity={identity} />;
}
