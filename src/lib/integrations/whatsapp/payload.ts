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

// Validated per entry, not as part of one body-wide schema: Meta batches
// several senders' events into one POST via `entry[]`, and a malformed entry
// must not cost the valid messages sitting beside it in the same request. A
// schema that covered `entry` as a single array (as this one used to) fails
// atomically — one bad element fails the whole array — so every message in
// every OTHER entry would be dropped too, silently, because this route
// answers 200 and Meta never re-delivers what it wasn't told failed.
const entrySchema = z.object({
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
});

const bodySchema = z.object({
  // Left as z.unknown() here on purpose — each element is validated on its
  // own by entrySchema below, once per entry, so one malformed entry cannot
  // fail its siblings' validation.
  entry: z.array(z.unknown()),
});

/** Entry-level counts for one POST — never message content. See `flattenWebhookBody`. */
export interface FlattenStats {
  /** Top-level entries this POST carried. */
  seen: number;
  /** Of those, how many failed structural validation and were skipped. */
  dropped: number;
}

/**
 * Meta packs several messages into one POST, so one HTTP request becomes N
 * rows in `webhook_events` and idempotency is per message id.
 *
 * Returns `[]` and never throws. This runs on an unauthenticated route after
 * the signature check, where a 500 on an unexpected shape is a worse answer
 * than an empty list: Meta re-delivers anything it does not see a 200 for, so
 * throwing turns one odd payload into a retry loop.
 *
 * `stats`, if passed, is filled in with entry-level COUNTS ONLY — never a
 * field from the payload — so a caller can log that something was dropped
 * without this function taking on any logging concern of its own, and
 * without changing what it returns to existing callers. A malformed entry no
 * longer costs the valid messages beside it (see `entrySchema` above), but it
 * still costs itself, silently, unless a caller does something with this.
 */
export function flattenWebhookBody(body: unknown, stats?: FlattenStats): InboundMessage[] {
  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) return [];

  const out: InboundMessage[] = [];
  let seen = 0;
  let dropped = 0;
  for (const rawEntry of parsedBody.data.entry) {
    seen += 1;
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      dropped += 1;
      continue;
    }

    for (const change of entry.data.changes) {
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
  if (stats) {
    stats.seen = seen;
    stats.dropped = dropped;
  }
  return out;
}
