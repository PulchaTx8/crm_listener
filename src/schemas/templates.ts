import { z } from 'zod';
import { SYSTEM_MESSAGE_DEFAULTS } from '@/lib/conversation/engine';
import type { SystemMessageKey } from '@/lib/conversation/engine';
import type { Enums } from '@/lib/supabase/database.types';
import {
  CAMPAIGN_RESOLVABLE,
  CAMPAIGN_VARIABLES,
  TEMPLATE_VARIABLES,
  variableFromPlaceholder,
  type TemplateVariable,
} from '@/lib/templates/variables';

/**
 * Mirrors 0109, 0110 and the four doors in 0113. Every bound here exists so
 * that a refusal the database would make anyway arrives as a field-level
 * message instead of a round trip — the reasoning schemas/music.ts sets out
 * for its own.
 */

/**
 * The keys, derived from `SYSTEM_MESSAGE_DEFAULTS` rather than listed again.
 * That record is total over `SystemMessageKey`, which is itself the
 * generated `system_message_key` enum, so this array cannot fall behind the
 * database — and a fourteenth key (as the three Block 19a added once did)
 * arrives here with no edit at all.
 *
 * Ordered by the enum, which is the order the Messages screen renders in: the
 * two standalone messages first, then the eight field prompts in the order the
 * conversation asks them.
 */
export const SYSTEM_MESSAGE_KEYS = Object.keys(SYSTEM_MESSAGE_DEFAULTS) as [
  SystemMessageKey,
  ...SystemMessageKey[],
];

/**
 * One thing this system sends through an approved Meta template.
 * `template_purpose` (0110, second value added by 0160).
 *
 * DERIVED FROM THE GENERATED ENUM, never re-declared, for exactly the reason
 * `lib/conversation/steps.ts` gives for `RequestedField` and `SystemMessageKey`
 * — and this file learned it the expensive way. Until Block 17a's fix wave the
 * union came from the hand-written array below, so 0160's `ADD VALUE` compiled
 * in silence: `WEB_VERIFICATION` existed in the database, `widget_request_code`
 * looked for a row with that purpose, and NOTHING a human could reach could
 * write one. The Templates screen had no card for it (it renders one per entry
 * in the array) and `templateRegistrationSchema` refused it (`z.enum` over the
 * same array), so every Station answered `no_template` for ever and the console
 * told operators to register it on a screen where it did not appear.
 */
export type TemplatePurpose = Enums<'template_purpose'>;

/**
 * A TOTAL record over `TemplatePurpose`, and its only job is to be total: a
 * third value added to the enum stops this file compiling until somebody names
 * it here, which is what makes the array below complete by construction rather
 * than by somebody remembering.
 *
 * The same trick `SYSTEM_MESSAGE_KEYS` above plays with `SYSTEM_MESSAGE_DEFAULTS`,
 * with a `true` where that one has a default body — there is no per-purpose
 * value worth holding in a schema module, since what each purpose MEANS is
 * three translated strings and belongs on the screen that renders them
 * (`templates/whatsapp/template-registry.tsx`, whose `purposeDetails` is total
 * over this same type for the same reason).
 */
const TEMPLATE_PURPOSE_SET: Record<TemplatePurpose, true> = {
  PICKUP_REMINDER: true,
  WEB_VERIFICATION: true,
};

/**
 * The purposes, in the order the Templates screen renders them — which is the
 * order `Object.keys` returns a string-keyed object literal in, i.e. the order
 * written above.
 */
export const TEMPLATE_PURPOSES = Object.keys(TEMPLATE_PURPOSE_SET) as [
  TemplatePurpose,
  ...TemplatePurpose[],
];

/**
 * `text` in Postgres has no length of its own, so an unbounded field would let
 * the form store what no screen could display. A WhatsApp text message is
 * capped at 4096 characters by the Cloud API itself, which is the honest bound
 * for a message body rather than a number chosen here.
 */
const MAX_MESSAGE_BODY = 4096;

const messageBody = z
  .string()
  .trim()
  .min(1, 'Write the message this Station should send.')
  .max(MAX_MESSAGE_BODY, `Keep it under ${MAX_MESSAGE_BODY} characters.`);

export const systemMessageFormSchema = z.object({
  companyId: z.string().uuid(),
  key: z.enum(SYSTEM_MESSAGE_KEYS),
  body: messageBody,
});
export type SystemMessageFormInput = z.infer<typeof systemMessageFormSchema>;

export const clearSystemMessageSchema = z.object({
  companyId: z.string().uuid(),
  key: z.enum(SYSTEM_MESSAGE_KEYS),
});
export type ClearSystemMessageInput = z.infer<typeof clearSystemMessageSchema>;

// ---------------------------------------------------------------------------
// Block 19a, Task 8. The two service hashtags.
// ---------------------------------------------------------------------------

/**
 * The same grammar `widget_installations_hashtag_shape` (0177) states, and
 * stated again rather than shared for the reason 0177's own comment gives:
 * a CHECK cannot reference this file, and this is a courtesy copy, not the
 * source of truth. `set_service_hashtags` validates the same shape and the
 * differ rule again, server-side, and its 22023 sentence is what actually
 * governs a caller who bypasses this form — this only catches the common
 * typo before a round trip.
 */
const HASHTAG_SHAPE = /^#[^\s#]{1,39}$/;

/**
 * An empty string is a THIRD valid state, not a shape error: it is how a
 * field is cleared (0177's own rule — `set_service_hashtags` folds '' to
 * NULL before either check runs), so this schema must accept it too, or
 * clearing a hashtag would fail client-side before it ever reached the door.
 */
const hashtagField = z
  .string()
  .trim()
  .max(40, 'Keep it to 40 characters or fewer.')
  .refine((v) => v === '' || HASHTAG_SHAPE.test(v), {
    message: 'Start the hashtag with # and use no spaces, up to 40 characters, with no second #.',
  });

export const serviceHashtagsFormSchema = z
  .object({
    companyId: z.string().uuid(),
    music: hashtagField,
    service: hashtagField,
  })
  .superRefine((value, ctx) => {
    if (
      value.music !== '' &&
      value.service !== '' &&
      value.music.toLowerCase() === value.service.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['service'],
        message: 'The music and service hashtags must be different.',
      });
    }
  });
export type ServiceHashtagsFormInput = z.infer<typeof serviceHashtagsFormSchema>;

/** The highest `{{n}}` a body actually uses — 0 for an approved fixed-text template. */
export function countPlaceholders(body: string): number {
  let highest = 0;
  for (const match of body.matchAll(/\{\{(\d+)\}\}/g)) {
    const index = Number(match[1]);
    if (index > highest) highest = index;
  }
  return highest;
}

/**
 * The registry form.
 *
 * The cross-field rule is the one that matters and the reason this is a
 * `superRefine` rather than four independent fields: the number of variable
 * descriptions must equal the body's highest `{{n}}`. 0113's door refuses the
 * mismatch with 22023 and 0111 refuses it again at send time — but 0111's
 * caller is 0112's unattended sweep, whose only reader is a server log. Caught
 * here, the same mistake is a message beside the field that is wrong.
 *
 * The error is attached to `variables`, not to the form, because that is the
 * field the operator can act on: the body is Meta's approved text and must be
 * transcribed exactly, so the descriptions are what gets corrected.
 *
 * `variables` is CHOSEN, not typed, since Block 29b-1: `register_message_template`
 * writes `template_variable[]` (0223), so a position names one of the seven
 * values in `TEMPLATE_VARIABLES` rather than prose an operator once wrote
 * ("nome do ouvinte") to describe what `{{1}}` carries. The full seven, not
 * `CAMPAIGN_VARIABLES` — a system purpose's own values (`PRIZE_NAME`,
 * `PICKUP_DEADLINE`, `VERIFICATION_CODE`) are exactly the three a campaign
 * cannot offer, and this is the screen that has to be able to name them.
 */
export const templateRegistrationSchema = z
  .object({
    companyId: z.string().uuid(),
    purpose: z.enum(TEMPLATE_PURPOSES),
    name: z
      .string()
      .trim()
      .min(1, 'Give the name exactly as Meta approved it.')
      .max(512),
    language: z
      .string()
      .trim()
      .min(1, 'Give the language code Meta approved, such as pt_BR.')
      .max(32),
    body: messageBody,
    variables: z.array(z.enum(TEMPLATE_VARIABLES as [TemplateVariable, ...TemplateVariable[]])),
    /**
     * Whether Meta approved this one under the Authentication category, which
     * is the same question as "does it carry an OTP button" — every
     * authentication template created since May 2023 has one.
     *
     * ASKED, NOT INFERRED, and 0165's header sets out why at length: the answer
     * lives in Meta's records, exactly like the name and the language this form
     * also transcribes rather than chooses.
     */
    otpButton: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const expected = countPlaceholders(value.body);
    if (value.variables.length !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variables'],
        message:
          expected === 0
            ? 'This body has no {{n}} placeholders, so it takes no variables.'
            : `This body uses ${expected} placeholder(s); describe each one.`,
      });
    }

    // The OTP button's parameter is the code, and the code is what the body
    // says with its placeholder — so this pairing describes a send that could
    // never be built. 0113's door refuses it with 22023 and the payload builder
    // throws for it; caught here it is a message beside the checkbox instead of
    // a round trip, which is the argument this whole file makes for itself.
    if (value.otpButton && expected === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['otpButton'],
        message:
          'An authentication template carries the code in {{1}}; this body has no placeholder.',
      });
    }
  });
export type TemplateRegistrationInput = z.infer<typeof templateRegistrationSchema>;

export const archiveTemplateSchema = z.object({ templateId: z.string().uuid() });
export type ArchiveTemplateInput = z.infer<typeof archiveTemplateSchema>;

/**
 * An optional address that a blank clears.
 *
 * Identical in shape to `optionalStationEmail` (schemas/stations.ts) and
 * identical in reason: trimming has to happen before the union, because
 * `z.literal('')` compares the raw value and `'   '` would otherwise fail both
 * arms at once.
 */
function optionalEmail(max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.union([z.literal(''), z.string().email().max(max)]),
  );
}

/**
 * What the marketing form posts.
 *
 * The channel-conditional rules are `superRefine`d rather than expressed as two
 * schemas, so the form has ONE parse and the error lands on the field that is
 * wrong. They restate what 0223's CHECK constraints hold structurally — which
 * is the point: the database is the authority and this is what turns a 23514
 * naming a constraint into a message beside an empty box.
 */
export const marketingTemplateSchema = z
  .object({
    templateId: z.string().uuid().optional(),
    companyId: z.string().uuid(),
    channel: z.enum(['WHATSAPP', 'EMAIL']),
    internalName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    body: z.string().trim().min(1).max(MAX_MESSAGE_BODY),
    subject: z.string().trim().max(200).optional(),
    name: z.string().trim().max(512).optional(),
    language: z.string().trim().max(20).optional(),
    // The closed vocabulary, not free strings: 0223 retyped the column to
    // template_variable[] and the door casts to it, so a string outside the
    // enum is a 22P02 from Postgres rather than a message beside a field.
    // `as` because z.enum wants a non-empty tuple, the same cast
    // SYSTEM_MESSAGE_KEYS and TEMPLATE_PURPOSES already make in this file.
    variables: z
      .array(z.enum(CAMPAIGN_VARIABLES as [TemplateVariable, ...TemplateVariable[]]))
      .max(20)
      .default([]),
    fromName: z.string().trim().max(120).optional(),
    // Trimmed BEFORE the union, not inside one arm of it. `.trim().email()
    // .or(z.literal(''))` looks equivalent and is not: z.literal compares the
    // RAW value, so '   ' fails the e-mail arm after trimming and fails the
    // literal arm before it, and a field the operator cleared with a space
    // becomes an error they cannot read. Same shape as schemas/stations.ts.
    fromEmail: optionalEmail(200).optional(),
    replyTo: optionalEmail(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.channel === 'EMAIL') {
      if (!value.subject) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'],
                       message: 'an e-mail needs a subject' });
      }
      // Every {{name}} the body uses must be a value this system substitutes.
      // Caught here rather than at the door so the operator sees WHICH name.
      for (const match of value.body.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        // RESOLVABLE, not merely known. variableFromPlaceholder answers the
        // whole vocabulary, and three of its seven values are ones a campaign
        // has no source for — the prize, the deadline and the code all come
        // from the specific caller that enqueues a system message. A body
        // naming {{prize_name}} would parse, save, and send "Oi Ana, você
        // ganhou !" to every listener on the list.
        const named = variableFromPlaceholder(match[1] ?? '');
        if (named === null || !CAMPAIGN_RESOLVABLE[named]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'],
                         message: `this body names {{${match[1]}}}, which is not a value this system substitutes` });
        }
      }
      return;
    }

    if (!value.name || !value.language) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'],
                     message: 'a WhatsApp template needs the name and language Meta approved' });
    }
  });

export type MarketingTemplateInput = z.infer<typeof marketingTemplateSchema>;
