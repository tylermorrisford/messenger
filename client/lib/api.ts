import type { KdfParams } from '@/lib/crypto/kdf';
import type { CredentialUpdate } from '@/lib/crypto/keys';
import type { WrappedKey } from '@/lib/crypto/conversation';
import type { EncryptedMessage } from '@/lib/crypto/message';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Session {
  accessToken: string;
  user: User;
}

export interface LoginResult extends Session {
  kdf: KdfParams;
  keyBundle: string;
  keyBundleNonce: string;
  keys: { version: number; x25519Pub: string; ed25519Pub: string };
}

export interface UserKey {
  version: number;
  x25519Pub: string;
  ed25519Pub: string;
  createdAt: string;
  retiredAt: string | null;
}

export type EmailPurpose = 'VERIFY' | 'LOGIN' | 'RECOVER';

export interface RegisterInput {
  email: string;
  name?: string;
  authKey: string;
  kdf: KdfParams;
  x25519Pub: string;
  ed25519Pub: string;
  keyBundle: string;
  keyBundleNonce: string;
  recoveryBundle: string;
  recoveryBundleNonce: string;
  inviteToken?: string;
  emailProof?: string;
}

export interface RecoverInput extends CredentialUpdate {
  emailProof: string;
  signature: string;
}

export interface ResetIdentityInput extends CredentialUpdate {
  emailProof: string;
  x25519Pub: string;
  ed25519Pub: string;
  recoveryBundle: string;
  recoveryBundleNonce: string;
}

export interface PublicProfile {
  id: string;
  email: string;
  name: string | null;
  keys: { version: number; x25519Pub: string; ed25519Pub: string };
}

export type MemberRole = 'OWNER' | 'MEMBER';

export interface Member {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  name: string | null;
  email: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  currentEpoch: number;
  defaultTtlSeconds: number | null;
  needsRotation: boolean;
  createdById: string;
  createdAt: string;
  members: Member[];
}

export interface CreateConversationInput {
  id: string;
  title?: string;
  key: Omit<WrappedKey, 'recipientUserId'>;
}

export interface RotateInput {
  expectedEpoch: number;
  removeUserId?: string;
  wrappedKeys: WrappedKey[];
}

export interface MyConversationKey {
  epoch: number;
  recipientKeyVersion: number;
  wrappedKey: string;
  distributorUserId: string;
  distributorKeyVersion: number;
  signature: string;
}

export interface MemberMissingKey {
  userId: string;
  keyVersion: number;
  x25519Pub: string;
  ed25519Pub: string;
}

export interface ConversationKeys {
  epoch: number;
  mine: MyConversationKey[];
  missing: MemberMissingKey[];
}

export interface Message extends EncryptedMessage {
  id: string;
  seq: number;
  conversationId: string;
  senderId: string;
  senderKeyVersion: number;
  epoch: number;
  ttlSeconds: number | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface SendMessageInput extends EncryptedMessage {
  epoch: number;
  senderKeyVersion: number;
  ttlSeconds?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** false for endpoints that take no bearer token, so their own 401s never trigger a refresh */
  auth?: boolean;
}

class ApiClient {
  private accessToken: string | null = null;

  /** Set by the auth provider; called when the refresh cookie stops working */
  onSessionExpired: (() => void) | null = null;

  private async send<T>(path: string, { method = 'GET', body, auth = true }: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
    });

    if (res.status === 204) {
      return undefined as T;
    }

    const data = await res.json();

    if (!res.ok) {
      throw new ApiError(res.status, data.error ?? 'Request failed', data.issues);
    }

    return data.data as T;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const tokenBefore = this.accessToken;

    try {
      return await this.send<T>(path, options);
    } catch (error) {
      if (options.auth === false || !(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
    }

    if (!(await this.refresh(tokenBefore))) {
      this.onSessionExpired?.();
      throw new ApiError(401, 'Session expired');
    }

    return this.send<T>(path, options);
  }

  /** Trades the refresh cookie for a new access token; the lock keeps concurrent 401s and other tabs from racing */
  async refresh(staleToken: string | null = this.accessToken): Promise<boolean> {
    return await navigator.locks.request('messenger-refresh', async () => {
      if (this.accessToken !== staleToken) {
        return true;
      }

      try {
        const { accessToken } = await this.send<{ accessToken: string }>('/api/auth/refresh', { method: 'POST', auth: false });
        this.accessToken = accessToken;
        return true;
      } catch (error) {
        if (error instanceof ApiError) {
          this.accessToken = null;
          return false;
        }
        throw error;
      }
    });
  }

  clearAccessToken(): void {
    this.accessToken = null;
  }

  async getKdfParams(email: string): Promise<KdfParams> {
    const { kdf } = await this.request<{ kdf: KdfParams }>(`/api/auth/params?email=${encodeURIComponent(email)}`, {
      auth: false,
    });

    return kdf;
  }

  sendEmailCode(email: string, purpose: EmailPurpose): Promise<void> {
    return this.request('/api/auth/email-code', { method: 'POST', body: { email, purpose }, auth: false });
  }

  async verifyEmailCode(email: string, purpose: EmailPurpose, code: string): Promise<string> {
    const { proof } = await this.request<{ proof: string }>('/api/auth/verify', {
      method: 'POST',
      body: { email, purpose, code },
      auth: false,
    });

    return proof;
  }

  async register(input: RegisterInput): Promise<Session> {
    const session = await this.request<Session>('/api/auth/register', { method: 'POST', body: input, auth: false });
    this.accessToken = session.accessToken;

    return session;
  }

  async login(email: string, authKey: string): Promise<LoginResult> {
    const result = await this.request<LoginResult>('/api/auth/login', { method: 'POST', body: { email, authKey }, auth: false });
    this.accessToken = result.accessToken;

    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/auth/refresh', { method: 'DELETE', auth: false });
    } finally {
      this.accessToken = null;
    }
  }

  me(): Promise<User> {
    return this.request<User>('/api/auth/me');
  }

  getRecoveryBundle(emailProof: string): Promise<{ recoveryBundle: string; recoveryBundleNonce: string }> {
    return this.request('/api/auth/recover/bundle', { method: 'POST', body: { emailProof }, auth: false });
  }

  async recover(input: RecoverInput): Promise<Session> {
    const session = await this.request<Session>('/api/auth/recover', { method: 'POST', body: input, auth: false });
    this.accessToken = session.accessToken;

    return session;
  }

  async resetIdentity(input: ResetIdentityInput): Promise<Session> {
    const session = await this.request<Session>('/api/auth/reset-identity', { method: 'POST', body: input, auth: false });
    this.accessToken = session.accessToken;

    return session;
  }

  getUserKeys(userId: string): Promise<UserKey[]> {
    return this.request<UserKey[]>(`/api/users/${encodeURIComponent(userId)}/keys`);
  }

  createInvite(email: string): Promise<{ id: string; expiresAt: string }> {
    return this.request('/api/invites', { method: 'POST', body: { email } });
  }

  getInvite(token: string): Promise<{ email: string; expiresAt: string }> {
    return this.request(`/api/invites/${encodeURIComponent(token)}`, { auth: false });
  }

  findUser(email: string): Promise<PublicProfile> {
    return this.request(`/api/users?email=${encodeURIComponent(email)}`);
  }

  createConversation(input: CreateConversationInput): Promise<Conversation> {
    return this.request('/api/conversations', { method: 'POST', body: input });
  }

  listConversations(): Promise<Conversation[]> {
    return this.request('/api/conversations');
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`);
  }

  updateConversation(id: string, input: { defaultTtlSeconds: number | null }): Promise<Conversation> {
    return this.request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
  }

  addMember(conversationId: string, key: WrappedKey): Promise<Member> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/members`, { method: 'POST', body: key });
  }

  inviteToConversation(conversationId: string, email: string): Promise<{ id: string; expiresAt: string }> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/invites`, { method: 'POST', body: { email } });
  }

  leaveConversation(conversationId: string): Promise<void> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/leave`, { method: 'POST' });
  }

  rotateConversationKey(conversationId: string, input: RotateInput): Promise<{ epoch: number }> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/rotate`, { method: 'POST', body: input });
  }

  getConversationKeys(conversationId: string): Promise<ConversationKeys> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/keys`);
  }

  addConversationKey(conversationId: string, key: WrappedKey): Promise<void> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/keys`, { method: 'POST', body: key });
  }

  listMessages(conversationId: string, { after = 0, limit = 100 }: { after?: number; limit?: number } = {}): Promise<Message[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/messages?after=${after}&limit=${limit}`);
  }

  sendMessage(conversationId: string, input: SendMessageInput): Promise<Message> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body: input });
  }
}

export const api = new ApiClient();
