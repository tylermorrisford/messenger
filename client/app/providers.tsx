'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

// Nimbus 3.8 renders a toast outlet whose store has no server snapshot, so the tree can only mount in the browser
const NimbusProviders = dynamic(() => import('./nimbus-providers').then((mod) => mod.NimbusProviders), { ssr: false });

export function Providers({ children }: { children: ReactNode }) {
  return <NimbusProviders>{children}</NimbusProviders>;
}
