import { api, ApiError, type Message } from './api';

export type ServerEvent =
  | { type: 'message'; message: Message }
  | { type: 'conversation'; conversationId: string; reason: string }
  | { type: 'resync' };

export interface SubscribeOptions {
  /** Runs on every (re)connect; sync here, because anything sent while disconnected was missed */
  onOpen: () => void;
  onEvent: (event: ServerEvent) => void;
  /** Runs once per outage, on the first failed attempt; retries continue in the background */
  onError: (error: unknown) => void;
}

const MAX_BACKOFF_MS = 15_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parse(name: string, data: string): ServerEvent | null {
  switch (name) {
    case 'message':
      // the server's events route writes exactly these shapes
      return { type: 'message', message: JSON.parse(data) as Message };
    case 'conversation':
      return { type: 'conversation', ...(JSON.parse(data) as { conversationId: string; reason: string }) };
    case 'resync':
      return { type: 'resync' };
    default:
      return null;
  }
}

async function read(body: ReadableStream<Uint8Array>, onEvent: (event: ServerEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name = '';
  let data: string[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        const event = name ? parse(name, data.join('\n')) : null;
        name = '';
        data = [];
        if (event) {
          onEvent(event);
        }
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
          name = value;
        } else if (field === 'data') {
          data.push(value);
        }
      }
    }
  }
}

/** Keeps a stream from GET /api/events open until the returned function is called */
export function subscribeToEvents({ onOpen, onEvent, onError }: SubscribeOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  const run = async () => {
    let failures = 0;

    while (!signal.aborted) {
      try {
        const res = await api.openStream('/api/events', signal);
        if (!res.body) {
          throw new Error('The event stream has no body');
        }
        failures = 0;
        onOpen();
        await read(res.body, onEvent);
      } catch (caught) {
        if (signal.aborted) {
          return;
        }
        // the auth provider is signing the user out
        if (caught instanceof ApiError && caught.status === 401) {
          return;
        }
        if (failures === 0) {
          onError(caught);
        }
        failures += 1;
      }
      // a clean end (the access token expired) reconnects after a second; failures back off
      await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS), signal);
    }
  };
  void run();

  return () => controller.abort();
}
