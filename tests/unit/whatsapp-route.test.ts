import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredRow {
  provider: string;
  external_id: string;
  payload: {
    wamid: string;
    metadata: { phone_number_id: string };
    from: string;
    profile_name: string | null;
    text: string;
    timestamp: string;
  };
}

const inserted: StoredRow[] = [];

// The real accessor is createServiceClient() in
// src/lib/supabase/service-client.ts — the brief this task started from
// named a `getSystemSupabase` that does not exist anywhere in this repo.
//
// Rows are captured one at a time (not the whole `upsert` argument as a
// single pushed element), because "was upsert called once" and "how many
// rows did it write" are different questions — a mock that only answers the
// first one cannot tell one-row-per-POST apart from one-row-per-message.
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceClient: () => ({
    from: () => ({
      upsert: (rows: StoredRow[]) => {
        inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const SECRET = 'test-app-secret';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';

const { GET, POST } = await import('@/app/api/webhooks/whatsapp/route');

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const post = (raw: string, signature: string | null) =>
  POST(
    new Request('http://localhost/api/webhooks/whatsapp', {
      method: 'POST',
      body: raw,
      headers: signature ? { 'x-hub-signature-256': signature } : {},
    }),
  );

function textMessage(id: string, from: string, text: string) {
  return { id, from, timestamp: '1786000000', type: 'text', text: { body: text } };
}

function singleMessageBody() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '1111' },
              messages: [textMessage('wamid.A', '5511988887777', '#EUQUERO')],
            },
          },
        ],
      },
    ],
  };
}

function twoMessageBody() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '1111' },
              messages: [
                textMessage('wamid.A', '5511988887777', '#EUQUERO'),
                textMessage('wamid.B', '5511977776666', '#OUTRA'),
              ],
            },
          },
        ],
      },
    ],
  };
}

const payload = JSON.stringify(singleMessageBody());

beforeEach(() => {
  inserted.length = 0;
});

describe('GET /api/webhooks/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const response = await GET(
      new Request(
        'http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('12345');
  });

  it('refuses a wrong verify token', async () => {
    const response = await GET(
      new Request(
        'http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe('POST /api/webhooks/whatsapp', () => {
  it('stores one row per message and answers 200', async () => {
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  // Writing unverified events would let anyone fill the table.
  it('refuses an invalid signature and writes nothing', async () => {
    const response = await post(payload, 'sha256=deadbeef');
    expect(response.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a missing signature and writes nothing', async () => {
    const response = await post(payload, null);
    expect(response.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  // Meta re-delivers anything it does not see a 200 for.
  it('answers 200 to a signed payload carrying nothing we use', async () => {
    const statuses = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1111' },
                statuses: [{ id: 'wamid.A', status: 'read' }],
              },
            },
          ],
        },
      ],
    });
    const response = await post(statuses, sign(statuses));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  // Mutation guard: a single-message payload cannot distinguish "one row per
  // message" from "one row per POST" — both produce a count of 1. A
  // two-message payload is the only shape that tells them apart.
  it('stores one row per message, not one per POST, when a request carries several', async () => {
    const twoMessages = JSON.stringify(twoMessageBody());
    const response = await post(twoMessages, sign(twoMessages));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(2);
    const ids = inserted.map((row) => row.external_id).sort();
    expect(ids).toEqual([sha256Hex('wamid.A'), sha256Hex('wamid.B')].sort());
  });

  // Whole-row comparison rather than five separate field assertions:
  // ingest_whatsapp_event (0062) reads exactly metadata.phone_number_id,
  // from, text, profile_name and timestamp, and the route must additionally
  // write the raw wamid (it is the only place it lives once the payload is
  // pruned at 30 days). Deleting any one of the six from route.ts, or adding
  // a seventh, changes this object and fails the comparison — five separate
  // .toBe() calls would not have caught a field going missing that nobody
  // wrote an assertion for.
  it('writes the full row 0062 requires: hashed external_id and the complete payload contract', async () => {
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(200);
    expect(inserted[0]).toEqual({
      provider: 'WHATSAPP',
      external_id: sha256Hex('wamid.A'),
      payload: {
        wamid: 'wamid.A',
        metadata: { phone_number_id: '1111' },
        from: '5511988887777',
        profile_name: null,
        text: '#EUQUERO',
        timestamp: '1786000000',
      },
    });
  });

  // The trap this whole route exists to avoid. Verifying a re-serialised
  // parsed body silently stops working the moment real formatting (pretty
  // printing, a trailing newline, different key order) diverges from
  // JSON.stringify's compact output — which production HTTP bodies routinely
  // do. This body is deliberately pretty-printed so a route that parses then
  // re-serialises before checking the signature fails this test with a 401.
  it('verifies the signature over the raw bytes, not a re-serialised body', async () => {
    const pretty = JSON.stringify(singleMessageBody(), null, 2);
    const response = await post(pretty, sign(pretty));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  // A body that is correctly signed but is not valid JSON is a legitimate
  // payload we have no use for, not an attack: Meta re-delivers anything it
  // does not see a 200 for, so 500 here would start a retry loop over a
  // request nothing can ever make parseable.
  it('answers 200, not 500, to a signed body that is not valid JSON', async () => {
    const notJson = 'not json';
    const response = await post(notJson, sign(notJson));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  // M4: rejected on a declared Content-Length alone, before the body is ever
  // read — this must not depend on the signature (there is nothing to verify
  // yet) or on the body actually containing that many bytes (Request here
  // trusts a hand-set header over the real length of the short string body).
  it('refuses a body whose declared Content-Length exceeds the cap, before reading it', async () => {
    const response = await POST(
      new Request('http://localhost/api/webhooks/whatsapp', {
        method: 'POST',
        body: payload,
        headers: { 'x-hub-signature-256': sign(payload), 'content-length': '5000000' },
      }),
    );
    expect(response.status).toBe(413);
    expect(inserted).toHaveLength(0);
  });

  // M5: a malformed sibling entry no longer costs the valid entry beside it
  // (Task 11's payload.ts fix), but it must still leave a signal an operator
  // can find. Counts only — never any field from the payload, since this
  // runs after signature verification and must not become a second place
  // message content can leak to.
  it('warns with counts only when an entry is dropped, after the signature check', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twoEntriesOneMalformed = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        ...singleMessageBody().entry,
        {
          changes: [
            {
              value: {
                // metadata omitted: this entry cannot resolve a phone_number_id.
                messages: [textMessage('wamid.LOST', '5511900000000', '#PERDIDA')],
              },
            },
          ],
        },
      ],
    });
    const response = await post(twoEntriesOneMalformed, sign(twoEntriesOneMalformed));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain('dropped 1 of 2');
    expect(message).not.toContain('wamid');
    expect(message).not.toContain('5511900000000');
    expect(message).not.toContain('PERDIDA');
    warnSpy.mockRestore();
  });
});
