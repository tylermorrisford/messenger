import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import './fonts.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Messenger',
  description: 'End-to-end encrypted messages for friends',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
