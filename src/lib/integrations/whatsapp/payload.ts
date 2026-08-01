import { z } from 'zod';

/** One inbound text message, flattened out of Meta's nested envelope. */
export interface InboundMessage {
  wamid: string;
  phoneNumberId: string;
  from: string;
  profileName: string | null;
  text: string;
  /** Epoch seconds, as a string — which is how Meta sends it. */
  timestamp: string;
}

const textMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const contactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string() }).optional(),
});

const bodySchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string().min(1) }),
            contacts: z.array(contactSchema).optional(),
            // Anything that is not a text message is dropped below rather than
            // refused here: a delivery receipt is a valid payload we have no
            // use for, not a malformed one.
            messages: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

/**
 * Meta packs several messages into one POST, so one HTTP request becomes N
 * rows in `webhook_events` and idempotency is per message id.
 *
 * Returns `[]` and never throws. This runs on an unauthenticated route after
 * the signature check, where a 500 on an unexpected shape is a worse answer
 * than an empty list: Meta re-delivers anything it does not see a 200 for, so
 * throwing turns one odd payload into a retry loop.
 */
export function flattenWebhookBody(body: unknown): InboundMessage[] {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return [];

  const out: InboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const { metadata, contacts, messages } = change.value;
      if (!messages) continue;

      const names = new Map(
        (contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null] as const),
      );

      for (const raw of messages) {
        const message = textMessageSchema.safeParse(raw);
        if (!message.success) continue;
        out.push({
          wamid: message.data.id,
          phoneNumberId: metadata.phone_number_id,
          from: message.data.from,
          profileName: names.get(message.data.from) ?? null,
          text: message.data.text.body,
          timestamp: message.data.timestamp,
        });
      }
    }
  }
  return out;
}
