'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useRouter } from 'next/navigation';
import { api, Message } from '@/lib/api';

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { user, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!user) {
      router.push('/login');
      return;
    }

    loadMessages();
  }, [user, router]);

  const loadMessages = async () => {
    try {
      const response = await api.getMessages();
      setMessages(response.data);
    } catch (err) {
      setError('Failed to load messages');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    setSubmitting(true);
    setError('');

    try {
      await api.createMessage(newMessage);
      setNewMessage('');
      await loadMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create message');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this message?')) return;

    try {
      await api.deleteMessage(id);
      await loadMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete message');
    }
  };

  if (loading) {
    return (
      <div className="container">
        <div className="card">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <nav className="nav">
        <h1 style={{ margin: 0 }}>Messages</h1>
        <div className="nav-links">
          <span>Welcome, {user?.name || user?.email}!</span>
          <button onClick={logout} className="btn btn-secondary">
            Logout
          </button>
        </div>
      </nav>

      <div className="container">
        {error && <div className="error">{error}</div>}

        <div className="card">
          <h2>Create Message</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <textarea
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="What's on your mind?"
                rows={3}
                required
                maxLength={5000}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Posting...' : 'Post Message'}
            </button>
          </form>
        </div>

        <div className="card">
          <h2>All Messages</h2>
          {messages.length === 0 ? (
            <p>No messages yet. Be the first to post!</p>
          ) : (
            <div>
              {messages.map((message) => (
                <div key={message.id} className="message-item">
                  <div className="message-meta">
                    <strong>{message.author.name || message.author.email}</strong>
                    {' • '}
                    <span>{new Date(message.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="message-content">{message.content}</div>
                  {user && message.authorId === user.id && (
                    <button
                      onClick={() => handleDelete(message.id)}
                      className="btn btn-danger"
                      style={{ marginTop: '0.5rem', fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
