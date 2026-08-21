'use server';

import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { createServiceClient } from '@/lib/supabase/service-client';
import { readAnswer } from '@/lib/widget/door-answer';
import { callerIp, ipKey, withinLimits } from '@/lib/widget/limits';
import {
  enterRefusal,
  readOptions,
  readSteps,
  type EnterRefusal,
  type WidgetPromotion,
} from '@/lib/widget/promotion-mapping';
import { WIDGET_SESSION_COOKIE, readSessionFor, type WidgetClaims } from '@/lib/widget/session';
import { publicKeySchema } from '@/schemas/widget';
import { enterPromotionSchema } from '@/schemas/widget-promotions';

/**
 * Block 17c. The widget's second button: a listener reads a promotion's rules,
 * agrees, answers what it asks, and the entry lands with source `WEB`.
 *
 * `readSessionFor`, NEVER `readSession`, in both exports. The widget cookie's
 * Path is `/w` — one path for every installation this deployment serves — so a
 * browser that identified at Station A presents that same cookie to Station B,
 * and only the installation comparison proves it was minted here.
 */

/** Reading the list is cheap; this is a ceiling on a script, not on a listener. */
const LIST_PER_IP_MINUTE = { limit: 20, windowSeconds: 60 } as const;

/**
 * Entering writes to four tables and cannot be undone from the widget. The
 * per-listener ceiling is the promotion's own rule — one entry unless it allows
 * repeats — and lives in `apply_participation`, atomic with the insert. This is
 * the one the database cannot express, because it has no idea what an IP
 * address is (0161's own comment says exactly that).
 */
const ENTER_PER_IP_HOUR = { limit: 20, windowSeconds: 3600 } as const;

export type ListState =
  | { status: 'loading' }
  | { status: 'ready'; promotions: WidgetPromotion[] }
  | { status: 'refused'; reason: EnterRefusal };

export type EnterState =
  | { status: 'idle' }
  | { status: 'entered' }
  /** The listener said no. A refusal row was written; nothing failed. */
  | { status: 'declined' }
  | { status: 'refused'; reason: EnterRefusal };

async function sessionFor(
  rawPublicKey: FormDataEntryValue | null,
): Promise<{ publicKey: string; claims: WidgetClaims } | null> {
  const key = publicKeySchema.safeParse(rawPublicKey);
  if (!key.success) return null;

  const secret = env.WIDGET_SESSION_SECRET;
  if (!secret) {
    logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing a promotion entry');
    return null;
  }

  const token = (await cookies()).get(WIDGET_SESSION_COOKIE)?.value;
  if (!token) return null;

  const claims = readSessionFor(token, secret, key.data);
  return claims === null ? null : { publicKey: key.data, claims };
}

/**
 * The Station's live promotions, as this listener sees them.
 *
 * NOT a `useActionState` pair: it takes no form and answers a question rather
 * than performing a submission — the shape 17b's `getWaitAction` established.
 */
export async function listPromotionsAction(rawPublicKey: string): Promise<ListState> {
  const session = await sessionFor(rawPublicKey);
  if (!session) return { status: 'refused', reason: 'no_session' };

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();

  const refusedBy = await withinLimits(limiter, session.publicKey, [
    {
      key: `widget:promo:list:ip:${ipKey(ip)}`,
      label: 'promo/list/ip/minute',
      ...LIST_PER_IP_MINUTE,
    },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  const { data, error } = await supabase.rpc('widget_promotions', {
    p_public_key: session.publicKey,
    p_member_id: session.claims.memberId,
  });

  if (error) {
    logger.error(
      { publicKey: session.publicKey, code: error.code, message: error.message },
      'widget: promotions list failed',
    );
    return { status: 'refused', reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) return { status: 'refused', reason: 'failed' };
  if (!answer.ok) return { status: 'refused', reason: enterRefusal(answer.reason) };

  const rows = (data as { promotions?: unknown }).promotions;
  if (!Array.isArray(rows)) {
    logger.error({ publicKey: session.publicKey }, 'widget: promotions answered without a list');
    return { status: 'refused', reason: 'failed' };
  }

  return {
    status: 'ready',
    promotions: rows.flatMap((raw): WidgetPromotion[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const row = raw as Record<string, unknown>;

      // A promotion with no rules cannot reach here — the door filters it out
      // (D3) — so a row arriving without them is a shape that changed under us
      // rather than an ordinary case, and it is dropped rather than rendered
      // with an agreement box above nothing.
      if (typeof row.id !== 'string' || typeof row.name !== 'string') return [];
      if (typeof row.rules !== 'string' || row.rules.trim() === '') return [];

      return [
        {
          id: row.id,
          name: row.name,
          rules: row.rules,
          artUrl: typeof row.art_url === 'string' ? row.art_url : null,
          thumbUrl: typeof row.thumb_url === 'string' ? row.thumb_url : null,
          alreadyEntered: row.already_entered === true,
          steps: readSteps(row.steps),
          options: readOptions(row.questions),
        },
      ];
    }),
  };
}

export async function enterPromotionAction(
  _previous: EnterState,
  formData: FormData,
): Promise<EnterState> {
  const session = await sessionFor(formData.get('publicKey'));
  if (!session) return { status: 'refused', reason: 'no_session' };

  const parsed = enterPromotionSchema.safeParse({
    promotionId: formData.get('promotionId'),
    // An unchecked box posts nothing at all, so the key is absent rather than
    // empty — which is what the schema's `.optional()` is reading.
    ...(formData.get('consent') === null ? {} : { consent: formData.get('consent') }),
    ...(formData.get('marketingConsent') === null
      ? {}
      : { marketingConsent: formData.get('marketingConsent') }),
    fields: formData.get('fields') ?? '{}',
    answers: formData.get('answers') ?? '[]',
  });
  if (!parsed.success) return { status: 'refused', reason: 'invalid' };

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();

  const refusedBy = await withinLimits(limiter, session.publicKey, [
    { key: `widget:promo:enter:ip:${ipKey(ip)}`, label: 'promo/enter/ip/hour', ...ENTER_PER_IP_HOUR },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  const { data, error } = await supabase.rpc('widget_enter_promotion', {
    p_public_key: session.publicKey,
    // FROM THE SESSION, NEVER FROM THE FORM. The schema is `.strict()`, so a
    // posted memberId is refused before this line — but the reason it is safe
    // is here: the only listener this action can act for is the one the signed
    // cookie names.
    p_member_id: session.claims.memberId,
    p_promotion_id: parsed.data.promotionId,
    p_consent: parsed.data.consent,
    p_fields: parsed.data.fields,
    p_answers: parsed.data.answers,
    // Block 29c, Task 9. TICKED IS AN OPT-IN AND UNTICKED IS NOT ALWAYS A
    // DECLINE. `widget_enter_promotion` (live on 0268) writes true whenever
    // this is true; false only when the listener has no whatsapp_marketing row
    // AND was actually shown the box; and nothing at all otherwise. Either way
    // the row is written only after the entry itself is recorded — never a
    // reason this call can fail on its own.
    //
    // THE "SHOWN THE BOX" HALF IS ABOUT THIS FILE. On Block 30d's fast path the
    // panel draws no consent screen, so no checkbox exists, so the schema above
    // reads an absent field and sends `false` from here — a default, not an
    // answer. 0268 refuses to record it as one (D10a): entering agrees to the
    // promotion's RULES and says nothing whatever about marketing. This comment
    // said an unticked box "writes an explicit decline" until fix round 2, and
    // it was the last place still saying so.
    p_marketing_consent: parsed.data.marketingConsent,
  });

  if (error) {
    logger.error(
      { publicKey: session.publicKey, code: error.code, message: error.message },
      'widget: enter_promotion failed',
    );
    return { status: 'refused', reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) {
    logger.error(
      { publicKey: session.publicKey },
      'widget: enter_promotion answered a shape this code does not know',
    );
    return { status: 'refused', reason: 'failed' };
  }

  if (answer.ok) return { status: 'entered' };

  // DECLINING IS NOT A FAILURE. The door wrote a promotion_refusals row and
  // said so; dressing that as an error would tell a listener something went
  // wrong when what happened is exactly what they asked for.
  if (answer.reason === 'refused') return { status: 'declined' };

  return { status: 'refused', reason: enterRefusal(answer.reason) };
}
