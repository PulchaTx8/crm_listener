import 'server-only';
import { env } from '@/lib/env';
import {
  LINK_MESSAGE_KEYS,
  resolveSystemMessage,
  toSystemMessageOverrides,
} from '@/lib/conversation/engine';
import { buildServiceLink, buildServiceMessage } from '@/lib/widget/service-link';
import type { ConversationDeps, LinkIntent, TurnOutcome } from '@/services/conversation';

/**
 * Block 19a, Task 5. `ingest_whatsapp_event` (0179) matched a hashtag -- a
 * promotion, or the Station's own music or service hashtag (D3) -- and left
 * the event PROCESSING with an intention rather than a send. This is what
 * turns that intention into one message: mint a code, resolve the address it
 * opens and the words in front of it, enqueue it, close the event.
 *
 * Reached from `runConversationTurn` ONLY after the live-conversation check
 * (D7) -- see that function's own comment in src/services/conversation.ts.
 * Nothing here re-checks it: by the time this runs, Node has already decided
 * no live conversation exists for this phone, so this file owns no part of
 * that guarantee and must not be called from anywhere else.
 */

/**
 * Thrown when this deployment cannot address its own links.
 *
 * NEVER caught here and turned into a finished event. `runConversationTurn`
 * calls this from inside a try whose `finally` releases the phone's lease but
 * leaves the EVENT exactly as it is; the worker's own catch (`runTurn` in
 * src/services/whatsapp.ts) defers it onto the retry ladder with this
 * message as `last_error` on the row -- visible to whoever reads it, and
 * retried a few times before it parks, rather than silently repeating the
 * same failure for ever. The alternative -- finishing the event as something
 * and sending nothing -- would look identical to D2's window on every screen
 * that reads `outcome`, and the two are not the same fact: one means "this
 * listener already has a working link", the other means "this deployment is
 * not configured to send one".
 */
export class SendServiceLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendServiceLinkError';
  }
}

export async function sendServiceLink(
  deps: ConversationDeps,
  turn: LinkIntent,
): Promise<TurnOutcome> {
  const baseUrl = env.NEXT_PUBLIC_SITE_URL;
  if (!baseUrl) {
    // Checked BEFORE minting a code, deliberately. mint_widget_link (0178)
    // spends D2's two-minute window the instant it returns a code -- the
    // window is keyed on (member, purpose) and, past that call, this
    // listener reads as "already answered" for two minutes even though
    // nothing was ever sent. Minting first and then discovering there is
    // nowhere to send the link would leave the listener answered by
    // silence for a purpose that already looks used.
    //
    // Absent means the local stack or a build (`SKIP_ENV_VALIDATION=1`
    // leaves it unset under the loose schema): `triggerTick` in
    // src/app/api/webhooks/whatsapp/route.ts reads the same variable and
    // treats its absence the same way, by doing nothing rather than firing
    // a request with nowhere to send it. This throws instead of doing
    // nothing, because unlike a missed tick trigger (which pg_cron corrects
    // within ten seconds regardless) a link this deployment fails to send
    // has no other mechanism that ever sends it -- the listener's hashtag
    // would otherwise be answered with permanent, unlogged silence.
    throw new SendServiceLinkError(
      'sendServiceLink: NEXT_PUBLIC_SITE_URL is not configured -- refusing to mint or send a link',
    );
  }

  // widget_link_send_context BEFORE mint_widget_link, not after (fix round 1,
  // Important #2). mint_widget_link spends D2's two-minute window the
  // instant it answers a code, keyed on (member, purpose); any failure past
  // that point -- this call, the enqueue, a dropped connection -- throws,
  // the event defers onto the retry ladder, and the RETRY lands inside the
  // window, where the mint answers null and the event closes
  // 'already_answered' having sent nothing. Reading the context first costs
  // one wasted round trip on D2's own null path (this is exactly that path)
  // and removes the class of failure entirely: the fallible read that
  // cannot yet have spent anything runs before the one write that can.
  //
  // It also returns the installation's public_key, which mint_widget_link
  // (0178) cannot -- D2's window means the null path has no code to attach
  // one to -- and this Station's own wording for the three LINK_* texts, in
  // the same call for the same reason whatsapp_prompt_context bundles a
  // promotion's copy with its overrides. Since 0181's fix round 1 it also
  // refuses a SUSPENDED Station or a BLOCKED Organization (0164) before any
  // code is minted.
  const { data: context, error: contextError } = await deps.supabase.rpc(
    'widget_link_send_context',
    { p_company_id: turn.company_id },
  );
  if (contextError) throw contextError;
  const { publicKey, systemMessages } = parseSendContext(context);

  const { data: code, error: mintError } = await deps.supabase.rpc('mint_widget_link', {
    p_company_id: turn.company_id,
    p_member_id: turn.member_id,
    p_purpose: turn.purpose,
    // The generated Args type carries the SQL DEFAULT null as an OPTIONAL
    // field (`p_promotion_id?: string`), not a nullable one -- so `null`
    // itself does not satisfy it, only omission does. `?? undefined` is the
    // established shape for this exact mismatch elsewhere (company-profile.ts,
    // api-credentials.ts).
    p_promotion_id: turn.promotion_id ?? undefined,
  });
  if (mintError) throw mintError;

  if (code === null) {
    // D2's window: this listener was already answered for this exact
    // purpose inside the last two minutes. Say nothing -- a second message
    // here is the whole defect the window exists to prevent. The context
    // read above ran anyway (the one wasted read this ordering costs) and
    // its result is simply discarded.
    await finish(deps, turn.event_id, 'already_answered');
    return { kind: 'already_answered' };
  }

  const link = buildServiceLink(baseUrl, {
    publicKey,
    code,
    purpose: turn.purpose,
    promotionId: turn.promotion_id,
  });

  const text = resolveSystemMessage(
    toSystemMessageOverrides(systemMessages),
    LINK_MESSAGE_KEYS[turn.purpose],
  );
  const body = buildServiceMessage(text, link);

  // enqueue_whatsapp_outbound (0071, replaced by 0165), never a raw
  // `.from('outbox_messages').insert(...)`: the table grants service_role
  // SELECT and UPDATE only (0059) -- no INSERT -- precisely so that every
  // write goes through a door that resolves the tenancy columns from the
  // integration rather than trusting a caller-supplied one. This is the
  // exact call the conversation engine's own `enqueue` (conversation.ts)
  // makes for every other outbound message in this block.
  const { error: enqueueError } = await deps.supabase.rpc('enqueue_whatsapp_outbound', {
    p_integration_id: turn.integration_id,
    // `turn.phone` IS Meta's own delivered form (fix round 1's Critical
    // finding: 0179 now returns exactly one phone field, under this name,
    // the same value in this intent and its two siblings -- see
    // linkIntentSchema's own comment in conversation.ts for the full
    // account of what the earlier `to_phone` field was and why it is gone).
    p_to_phone: turn.phone,
    p_body: body,
    p_interactive: null,
    p_dedupe_key: `${turn.dedupe_prefix}:link`,
  });
  if (enqueueError) throw enqueueError;

  await finish(deps, turn.event_id, 'link_sent');
  return { kind: 'link_sent' };
}

/**
 * Closes the event through the same door `conversation.ts`'s own `finish`
 * uses. NOT IMPORTED FROM THERE, on purpose: `conversation.ts` imports
 * `sendServiceLink` from this file, and importing a value back the other way
 * would make the two modules depend on each other at runtime rather than in
 * type position only. Five lines duplicated is cheaper than a cycle.
 */
async function finish(deps: ConversationDeps, eventId: string, outcome: string): Promise<void> {
  const { error } = await deps.supabase.rpc('finish_whatsapp_turn', {
    p_event_id: eventId,
    p_outcome: outcome,
  });
  if (error) throw error;
}

/**
 * `widget_link_send_context`'s answer, narrowed from `Json`. Checked rather
 * than cast for the same reason `parseInboundTurn` checks the ingest's own
 * jsonb (conversation.ts): it is built in plpgsql and read here, and nothing
 * else keeps the two in step.
 */
function parseSendContext(raw: unknown): {
  publicKey: string;
  systemMessages: Record<string, string>;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SendServiceLinkError('widget_link_send_context returned nothing usable');
  }
  const record = raw as { publicKey?: unknown; systemMessages?: unknown };
  if (typeof record.publicKey !== 'string' || record.publicKey === '') {
    throw new SendServiceLinkError('widget_link_send_context returned no public key');
  }
  const systemMessages =
    typeof record.systemMessages === 'object' &&
    record.systemMessages !== null &&
    !Array.isArray(record.systemMessages)
      ? (record.systemMessages as Record<string, string>)
      : {};
  return { publicKey: record.publicKey, systemMessages };
}
