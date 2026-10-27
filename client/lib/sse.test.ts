import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { subscribeToEvents, type ServerEvent } from './sse';

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });

  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribeToEvents', () => {
  it('parses events across chunk boundaries and skips comments', async () => {
    vi.spyOn(api, 'openStream').mockResolvedValueOnce(
      streamOf([
        ': connected\n\nevent: conv',
        'ersation\ndata: {"conversationId":"c1",',
        '"reason":"settings"}\n\n: ping\n\nevent: resync\ndata: {}\n\n',
      ]),
    );
    const events: ServerEvent[] = [];
    const onOpen = vi.fn();
    const onError = vi.fn();

    const unsubscribe = subscribeToEvents({ onOpen, onEvent: (event) => events.push(event), onError });

    await vi.waitFor(() => expect(events).toHaveLength(2));
    unsubscribe();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'conversation', conversationId: 'c1', reason: 'settings' }, { type: 'resync' }]);
  });

  it('reports the first failure and stops once unsubscribed', async () => {
    const openStream = vi.spyOn(api, 'openStream').mockRejectedValue(new Error('down'));
    const onError = vi.fn();

    const unsubscribe = subscribeToEvents({ onOpen: vi.fn(), onEvent: vi.fn(), onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    unsubscribe();
    expect(openStream).toHaveBeenCalledTimes(1);
  });
});
