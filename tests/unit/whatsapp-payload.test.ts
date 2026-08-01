import { describe, expect, it } from 'vitest';
import { flattenWebhookBody } from '@/lib/integrations/whatsapp/payload';

const body = (messages: unknown[], contacts: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '551133334444', phone_number_id: '1111' },
            contacts,
            messages,
          },
        },
      ],
    },
  ],
});

const textMessage = (id: string, text: string) => ({
  from: '5511988887777',
  id,
  timestamp: '1786000000',
  type: 'text',
  text: { body: text },
});

describe('flattenWebhookBody', () => {
  it('returns one message per wamid, not one per request', () => {
    const result = flattenWebhookBody(
      body([textMessage('wamid.A', '#EUQUERO'), textMessage('wamid.B', '#OUTRA')]),
    );
    expect(result.map((m) => m.wamid)).toEqual(['wamid.A', 'wamid.B']);
    expect(result[0]?.phoneNumberId).toBe('1111');
    expect(result[0]?.text).toBe('#EUQUERO');
  });

  it('picks the profile name up from contacts by wa_id', () => {
    const result = flattenWebhookBody(
      body([textMessage('wamid.A', 'oi')], [
        { wa_id: '5511988887777', profile: { name: 'Joana' } },
      ]),
    );
    expect(result[0]?.profileName).toBe('Joana');
  });

  it('leaves the profile name null when contacts do not carry it', () => {
    expect(flattenWebhookBody(body([textMessage('wamid.A', 'oi')]))[0]?.profileName).toBeNull();
  });

  // Regression coverage: a wa_id lookup can be replaced with a positional one
  // (contacts[i] for messages[i]) without any of the single-message,
  // single-contact tests above noticing, because position and wa_id coincide
  // whenever there is exactly one of each. Two contacts in an order that does
  // not match the two messages is the only shape that tells them apart.
  it('attaches each name to its own message by wa_id, not by array position', () => {
    const messageFromA = {
      from: '5511111111111',
      id: 'wamid.A',
      timestamp: '1786000000',
      type: 'text',
      text: { body: 'oi' },
    };
    const messageFromB = {
      from: '5511222222222',
      id: 'wamid.B',
      timestamp: '1786000000',
      type: 'text',
      text: { body: 'oi' },
    };
    const result = flattenWebhookBody(
      body(
        [messageFromA, messageFromB],
        [
          { wa_id: '5511222222222', profile: { name: 'Bruno' } },
          { wa_id: '5511111111111', profile: { name: 'Ana' } },
        ],
      ),
    );
    expect(result.find((m) => m.wamid === 'wamid.A')?.profileName).toBe('Ana');
    expect(result.find((m) => m.wamid === 'wamid.B')?.profileName).toBe('Bruno');
  });

  // Delivery and read receipts arrive on the same webhook and carry no
  // participation. Storing them would make the table mostly noise.
  it('ignores status callbacks', () => {
    const statuses = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1111' },
                statuses: [{ id: 'wamid.A', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(flattenWebhookBody(statuses)).toEqual([]);
  });

  it('ignores non-text messages', () => {
    const audio = { from: '551199', id: 'wamid.C', timestamp: '1786000000', type: 'audio' };
    expect(flattenWebhookBody(body([audio]))).toEqual([]);
  });

  it('returns [] rather than throwing on rubbish', () => {
    expect(flattenWebhookBody(null)).toEqual([]);
    expect(flattenWebhookBody({ entry: 'not an array' })).toEqual([]);
    expect(flattenWebhookBody({})).toEqual([]);
  });

  // A malformed ENTRY must not cost the valid messages sitting beside it in a
  // different entry of the same POST: this route answers 200 regardless, so
  // Meta never re-delivers whatever a body-wide parse failure silently
  // dropped. Two entries here, the first entirely well formed, the second
  // missing `metadata` (required by the schema) — only the second is lost.
  it('keeps a valid entry when a sibling entry in the same request is malformed', () => {
    const malformedEntry = {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            // metadata omitted: this change cannot resolve a phone_number_id.
            messages: [textMessage('wamid.B', '#PERDIDA')],
          },
        },
      ],
    };
    const wellFormed = body([textMessage('wamid.A', '#EUQUERO')]);
    const result = flattenWebhookBody({
      object: 'whatsapp_business_account',
      entry: [...wellFormed.entry, malformedEntry],
    });
    expect(result.map((m) => m.wamid)).toEqual(['wamid.A']);
  });
});
