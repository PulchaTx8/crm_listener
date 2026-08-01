import { describe, expect, it } from 'vitest';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';

const input = { phoneNumberId: '1111', to: '5511988887777', body: 'oi' };

function stubFetch(status: number, payload: unknown) {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('GraphTransport', () => {
  it('returns the wamid Meta accepted', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(200, { messages: [{ id: 'wamid.OUT' }] }),
    );
    expect(await transport.sendText(input)).toEqual({ ok: true, externalId: 'wamid.OUT' });
  });

  it('marks a rate limit retryable', async () => {
    const transport = new GraphTransport('token', stubFetch(429, { error: { message: 'slow down' } }));
    const result = await transport.sendText(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('marks a server error retryable', async () => {
    const transport = new GraphTransport('token', stubFetch(503, {}));
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  // A bad number never becomes a good one. Retrying it forever is how an
  // outbox fills with rows nobody looks at.
  it('marks a rejected recipient permanent', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(400, { error: { message: 'Invalid parameter' } }),
    );
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: false });
  });

  it('marks a network failure retryable rather than throwing', async () => {
    const transport = new GraphTransport('token', async () => {
      throw new Error('ECONNRESET');
    });
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });
});

describe('FakeTransport', () => {
  it('records what it was asked to send', async () => {
    const transport = new FakeTransport();
    await transport.sendText(input);
    expect(transport.sent).toEqual([input]);
  });

  it('fails once when told to', async () => {
    const transport = new FakeTransport();
    transport.failNext(true);
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
    expect(await transport.sendText(input)).toMatchObject({ ok: true });
  });
});
