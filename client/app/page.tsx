'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading) {
      if (user) {
        router.push('/messages');
      } else {
        router.push('/login');
      }
    }
  }, [user, loading, router]);

  return (
    <div className="container">
      <div className="card">
        <h1>Loading...</h1>
      </div>
    </div>
  );
}
