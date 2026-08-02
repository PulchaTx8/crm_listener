import { describe, expect, it } from 'vitest';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import type { Interactive } from '@/lib/integrations/whatsapp/interactive';

const input = { phoneNumberId: '1111', to: '5511988887777', body: 'oi' };

const consentInteractive: Interactive = {
  kind: 'buttons',
  body: 'Want to enter?',
  imageUrl: null,
  buttons: [
    { id: 'yes', title: 'Quero!' },
    { id: 'no', title: 'Agora não' },
  ],
};

const interactiveInput = { phoneNumberId: '1111', to: '5511988887777', interactive: consentInteractive };

// A shape buildInteractivePayload refuses before any network call is made.
const oversizedInteractive: Interactive = {
  kind: 'buttons',
  body: 'Want to enter?',
  imageUrl: null,
  buttons: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
    { id: 'd', title: 'D' },
  ],
};

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

// Captures the URL and parsed JSON body of the single call made to it, so a
// test can assert what was actually sent rather than just the SendResult.
function capturingFetch(status: number, payload: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
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

  describe('sendInteractive', () => {
    it('returns the wamid Meta accepted, same as sendText', async () => {
      const transport = new GraphTransport(
        'token',
        stubFetch(200, { messages: [{ id: 'wamid.OUT' }] }),
      );
      expect(await transport.sendInteractive(interactiveInput)).toEqual({
        ok: true,
        externalId: 'wamid.OUT',
      });
    });

    // Same shared `post` helper as sendText, so the retryable/permanent
    // classification is already proven by that suite; this only proves
    // sendInteractive is wired to it, not the classification itself.
    it('marks a rate limit retryable', async () => {
      const transport = new GraphTransport('token', stubFetch(429, { error: { message: 'slow down' } }));
      expect(await transport.sendInteractive(interactiveInput)).toMatchObject({
        ok: false,
        retryable: true,
      });
    });

    it('posts the built interactive payload to the same endpoint sendText uses', async () => {
      const { fetchImpl, calls } = capturingFetch(200, { messages: [{ id: 'wamid.OUT' }] });
      const transport = new GraphTransport('token', fetchImpl);
      await transport.sendInteractive(interactiveInput);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://graph.facebook.com/v21.0/1111/messages');
      expect(calls[0]?.body).toMatchObject({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511988887777',
        type: 'interactive',
        interactive: { type: 'button' },
      });
    });

    // The three-button limit is enforced before any network attempt, not
    // folded into a permanent SendResult -- a config mistake and a rejected
    // recipient are not the same kind of failure.
    it('refuses an oversized interactive without ever calling fetch', async () => {
      let fetchCalled = false;
      const transport = new GraphTransport('token', async () => {
        fetchCalled = true;
        throw new Error('should not be called');
      });
      await expect(
        transport.sendInteractive({ ...interactiveInput, interactive: oversizedInteractive }),
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);
    });
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

  describe('sendInteractive', () => {
    it('records interactive sends alongside sent, in their own array', async () => {
      const transport = new FakeTransport();
      await transport.sendInteractive(interactiveInput);
      expect(transport.sentInteractive).toEqual([interactiveInput]);
      expect(transport.sent).toEqual([]);
    });

    it('fails once when told to, same as sendText', async () => {
      const transport = new FakeTransport();
      transport.failNext(true);
      expect(await transport.sendInteractive(interactiveInput)).toMatchObject({
        ok: false,
        retryable: true,
      });
      expect(await transport.sendInteractive(interactiveInput)).toMatchObject({ ok: true });
    });

    it('refuses an oversized interactive without recording it', async () => {
      const transport = new FakeTransport();
      await expect(
        transport.sendInteractive({ ...interactiveInput, interactive: oversizedInteractive }),
      ).rejects.toThrow();
      expect(transport.sentInteractive).toEqual([]);
    });
  });
});
