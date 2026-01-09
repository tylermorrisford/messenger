const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface User {
  id: number;
  email: string;
  name: string | null;
  createdAt: string;
}

export interface Message {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  authorId: number;
  author: {
    id: number;
    email: string;
    name: string | null;
  };
}

export interface AuthResponse {
  success: boolean;
  data: {
    token: string;
    user: User;
  };
}

export interface MessagesResponse {
  success: boolean;
  data: Message[];
}

export interface MessageResponse {
  success: boolean;
  data: Message;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

class ApiClient {
  private getToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong');
    }

    return data;
  }

  // Auth endpoints
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async getMe(): Promise<{ success: boolean; data: User }> {
    return this.request<{ success: boolean; data: User }>('/api/auth/me');
  }

  // Message endpoints
  async getMessages(): Promise<MessagesResponse> {
    return this.request<MessagesResponse>('/api/messages');
  }

  async createMessage(content: string): Promise<MessageResponse> {
    return this.request<MessageResponse>('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async updateMessage(id: number, content: string): Promise<MessageResponse> {
    return this.request<MessageResponse>(`/api/messages/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  }

  async deleteMessage(id: number): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/api/messages/${id}`, {
      method: 'DELETE',
    });
  }
}

export const api = new ApiClient();
