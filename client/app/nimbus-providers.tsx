'use client';

import { NimbusProvider } from '@commercetools/nimbus';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/contexts/auth-context';

export function NimbusProviders({ children }: { children: ReactNode }) {
  const router = useRouter();

  return (
    <NimbusProvider locale="en-US" router={{ navigate: router.push }} loadFonts={false}>
      <AuthProvider>{children}</AuthProvider>
    </NimbusProvider>
  );
}
