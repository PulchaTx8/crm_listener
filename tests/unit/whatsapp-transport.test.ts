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

// For bodies that are not `JSON.stringify`-able the normal way: text that
// isn't JSON at all, or a JSON value that parses but isn't the object shape
// extractMessageId/extractError expect.
function stubFetchRaw(status: number, rawBody: string) {
  return async () =>
    new Response(rawBody, {
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

  it('marks a timeout retryable', async () => {
    const transport = new GraphTransport('token', stubFetch(408, { error: { message: 'timeout' } }));
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  // A credential problem is not a fact about the message. Ops rotates or
  // restores the token and the identical request then succeeds, so this must
  // not be filed next to a malformed number.
  it('marks an expired credential retryable', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(401, { error: { message: 'Invalid OAuth access token' } }),
    );
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  it('marks a forbidden credential retryable', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(403, { error: { message: 'Permissions error' } }),
    );
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

  // Meta answering 200 with no id is the case the "accepted without a message
  // id" branch exists for. Treating this as success would have the worker
  // mark an outbox row SENT with no external_id to write — exactly the row
  // the outbox_messages CHECK constraint exists to refuse, but only after the
  // worker already believed the send had gone through.
  it('marks a 200 with no messages key retryable rather than a success', async () => {
    const transport = new GraphTransport('token', stubFetch(200, {}));
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  // Same case, different guard: `messages` present but empty. extractMessageId
  // checks the missing key and the empty array separately, so this needs its
  // own test or the empty-array guard is never exercised.
  it('marks a 200 with an empty messages array retryable rather than a success', async () => {
    const transport = new GraphTransport('token', stubFetch(200, { messages: [] }));
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  // Every other stub in this file hands back a well-formed object, so none of
  // them exercises the `.catch(() => ({}))` around response.json() or the
  // `typeof payload !== 'object'` guards in extractMessageId/extractError. A
  // regression removing any of those turns a malformed Graph response into a
  // thrown exception instead of a SendResult.
  it('returns a SendResult rather than throwing when the body is not valid JSON', async () => {
    const transport = new GraphTransport('token', stubFetchRaw(500, '{not json'));
    const result = await transport.sendText(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('returns a SendResult rather than throwing when the body is a bare JSON string', async () => {
    const transport = new GraphTransport('token', stubFetchRaw(500, JSON.stringify('unexpected')));
    const result = await transport.sendText(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('returns a SendResult rather than throwing when the body is JSON null', async () => {
    const transport = new GraphTransport('token', stubFetchRaw(500, JSON.stringify(null)));
    const result = await transport.sendText(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
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
