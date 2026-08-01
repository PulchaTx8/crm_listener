import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredRow {
  provider: string;
  external_id: string;
  payload: { wamid: string; from?: string; text?: string; timestamp?: string };
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

  // Mutation guard: external_id must be the hash, never the raw provider id.
  // 0058 carries a CHECK (`^[0-9a-f]{64}$`) that would refuse a raw wamid at
  // the database, but the route must not rely on that backstop to catch it —
  // a raw id decodes to bytes containing the counterparty's phone number.
  it('writes the SHA-256 of the wamid into external_id, never the raw id', async () => {
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(200);
    expect(inserted[0]?.external_id).toBe(sha256Hex('wamid.A'));
    expect(inserted[0]?.external_id).not.toBe('wamid.A');
  });

  // The raw id lives ONLY in payload.wamid — it is what prune_webhook_payloads
  // (design spec D9) clears after 30 days, and once it is gone this is the
  // only place it ever existed.
  it('writes the raw wamid into payload.wamid', async () => {
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(200);
    expect(inserted[0]?.payload.wamid).toBe('wamid.A');
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
});
