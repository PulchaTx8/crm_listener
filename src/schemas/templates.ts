import { z } from 'zod';
import { SYSTEM_MESSAGE_DEFAULTS } from '@/lib/conversation/engine';
import type { SystemMessageKey } from '@/lib/conversation/engine';
import type { Enums } from '@/lib/supabase/database.types';

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

/**
 * A Meta template parameter is capped at 1024 characters, and every variable
 * description on the registry screen labels one — so a description longer than
 * the value it describes is a bound worth having.
 */
const MAX_VARIABLE_DESCRIPTION = 200;

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
    variables: z.array(
      z
        .string()
        .trim()
        .min(1, 'Say what this position means.')
        .max(MAX_VARIABLE_DESCRIPTION),
    ),
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
