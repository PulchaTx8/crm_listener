import { z } from 'zod';
import type { Enums } from '@/lib/supabase/database.types';

/**
 * The fields the bot may ask a listener for. Every marked field is asked the
 * same way: the owner was asked directly whether one would ever need settings
 * of its own — required versus optional, or its own place in the queue — and
 * said no (design spec D6). That answer is why this is a list on the promotion
 * rather than a table with a row per field.
 *
 * Each value names the `members` column it fills, not the label on screen. The
 * label is interface and will be reworded; the column is the contract.
 *
 * A TOTAL RECORD OVER THE GENERATED ENUM, and the gender block is what paid for
 * it. Until now this was a hand-written array, and a hand-written array is a
 * SECOND declaration of `promotion_requested_field` with nothing holding the two
 * together: 0213 could have added `country` to the database and left this file
 * compiling in silence, exactly as 0160 once added `WEB_VERIFICATION` to
 * `template_purpose` beside an array that did not have it — `schemas/templates.ts`
 * carries that story in full, and the cost was a screen with no card for a value
 * the database already had, and a console telling operators to register it there.
 *
 * So the array is DERIVED from a record the compiler forces to be total. An
 * eleventh enum value stops this file building until somebody places it, which
 * is the point: placing it is the work, and forgetting to is the defect.
 *
 * `true` carries nothing — the record exists to be total, not to hold a value.
 * The trick, and the reason for it, are `TEMPLATE_PURPOSE_SET`'s.
 */
const REQUESTED_FIELD_SET: Record<Enums<'promotion_requested_field'>, true> = {
  full_name: true,
  address: true,
  city: true,
  neighbourhood: true,
  // Block 28, D10. Beside the other three geography fields rather than at the
  // end, because this list is the ORDER the checkboxes render in and an
  // operator ticking a place ticks the whole place. The database enum places it
  // elsewhere, and nothing reads the two against each other — this is a
  // screen's order, not a mirror of a declaration.
  country: true,
  age: true,
  // The gender block, and it REVERSES this file's own previous paragraph, which
  // read: "Three fields the owner's old system offered — gender, favourite
  // station, favourite show — are deliberately missing. They map to no column,
  // and his decision was that the new system will not have them (D5)."
  //
  // D5 stood for three years' worth of blocks and is reversed for one of the
  // three only. The reason changed rather than turning out to be wrong: when it
  // was written there was no segmented outbound messaging, so a gender column
  // answered a question nobody could ask. Block 29 creates that question — a
  // campaign addressed to the women of a Station — and the field is reopened for
  // TARGETING and not for eligibility (0220's header states the difference and
  // what it would cost to cross it).
  //
  // `favourite station` and `favourite show` are NOT reopened. D5 stands for
  // both, and this comment is where a future reader finds that out.
  //
  // Beside `age` for the same reason `country` sits beside the geography: they
  // are the same kind of question about the same person, and an operator ticking
  // one usually ticks the other.
  gender: true,
  cpf: true,
  passport: true,
  discovery_source: true,
};

/**
 * The fields, in the order the WhatsApp tab lists them — which is the order
 * `Object.keys` returns a string-keyed object literal in, i.e. the order
 * written above.
 */
export const REQUESTED_FIELD_ORDER = Object.keys(REQUESTED_FIELD_SET) as [
  Enums<'promotion_requested_field'>,
  ...Enums<'promotion_requested_field'>[],
];

export type RequestedField = Enums<'promotion_requested_field'>;

const requestedField = z.enum(REQUESTED_FIELD_ORDER);

/**
 * Mirrors 0040_promotions.sql. Every rule below has a constraint behind it, and
 * that duplication is the point rather than an oversight: this one gives the
 * verdict on the screen without a round trip, and the constraint gives it
 * whether or not this ran. Where they disagree, the constraint is right — it is
 * the one no caller can skip.
 */
export const promotionFormSchema = z
  .object({
    companyId: z.string().uuid(),

    name: z.string().trim().min(1, 'Name the promotion.').max(120),

    // Instants, not calendar days. The screen converts to and from the
    // Station's timezone; what travels is UTC (spec L2).
    startsAt: z.string().datetime({ message: 'Give the promotion a start.' }),
    endsAt: z.string().datetime({ message: 'Give the promotion an end.' }),

    // How the radio's own website refers to this promotion. Optional, and
    // unique per Station while live — the collision is caught by the database
    // and comes back as a sentence, because nothing here can know about the
    // other promotions.
    siteIntegrationCode: z
      .number()
      .int('The integration code must be a whole number.')
      .nonnegative('The integration code cannot be negative.')
      .nullable()
      .optional()
      .transform((v) => (v === null ? undefined : v)),

    // BLOCK 24 REMOVED `callToAction`, AND THE COLUMN STAYS (D2). It was the
    // sentence under the promotion's name in the WhatsApp consent message, and
    // the owner took it off the screen once the widget became the door most
    // Stations use. `buildConsentInteractive` already renders the name alone
    // when it is null, so nothing downstream needed changing — and
    // `update_promotion` replaces every field on every call, so each promotion's
    // column goes to null the next time it is saved.
    //
    // Absent from this schema rather than optional-and-ignored: a field
    // validated here is a field this form believes it is saving, which is the
    // argument the two pictures' own comment makes below.

    allowMultipleEntries: z.boolean(),
    minHoursBetweenEntries: z
      .number()
      .int('The interval must be a whole number of hours.')
      .min(1, 'The interval must be at least one hour.')
      .max(8760, 'The interval cannot be longer than a year.')
      .nullable()
      .optional()
      .transform((v) => (v === null ? undefined : v)),

    // The per-person ceiling D1 asked for, mirroring promotions_entry_ceiling_shape
    // (0052): `max_entries_per_member is null or (allow_multiple_entries and
    // max_entries_per_member >= 2)`. Absent means no ceiling.
    //
    // The upper bound is Postgres's, not a product rule: p_max_entries_per_member
    // is `integer`, so a hand-posted 2147483648 comes back as 22003, maps to
    // InternalError and reaches the operator as a generic "Could not save" —
    // the same trap promotionPrizeLinkSchema's own ceiling exists to close.
    maxEntriesPerMember: z
      .number()
      .int('The ceiling must be a whole number.')
      .min(2, 'A ceiling of one is what turning repeat entries off already says, so set two or more.')
      .max(2_147_483_647, 'That is a higher ceiling than this system can count.')
      .nullable()
      .optional()
      .transform((v) => (v === null ? undefined : v)),

    requireCorrectAnswer: z.boolean(),

    whatsappEnabled: z.boolean(),
    /**
     * Block 17c (D1). The sister of the flag above: a promotion takes part
     * through WhatsApp, through the embedded widget, through both, or through
     * neither. Either one allows the art and the requested fields; see the
     * cross-field rule below for what stays WhatsApp's alone.
     */
    webEnabled: z.boolean(),
    /**
     * What a listener agrees to before entering from the website (D2).
     *
     * OPTIONAL EVEN WITH `webEnabled` ON, deliberately: the owner rejected a
     * mandatory rules field, so a promotion can be marked for the web while
     * somebody is still writing the wording. It simply does not appear in the
     * widget until both are true, and the screen says which half is missing.
     */
    rules: z.string().max(20_000).nullish(),

    hashtag: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

    // NEITHER PICTURE IS IN THIS SCHEMA, and their absence is the decision
    // Block 14 turns on. set_promotion_art and set_promotion_thumb are their
    // only writers (0144); create_promotion and update_promotion no longer take
    // them at all. A field validated here would be a field this form believes
    // it is saving, and the wholesale replace would clear it on every Save.
    //
    // The tick that used to accompany the banner is gone with it: use_art is set
    // from the presence of the address, which is what promotions_art_shape has
    // always required.

    // BLOCK 24 REMOVED `yesButtonLabel` and `noButtonLabel`, AND THE COLUMNS
    // STAY (D2). They titled the two buttons of the WhatsApp consent message,
    // and `engine.ts` has always fallen back to DEFAULT_YES_BUTTON_LABEL /
    // DEFAULT_NO_BUTTON_LABEL for a blank one — "the default is copy, not data",
    // as that file puts it. So every promotion now takes the fallback, and what
    // a listener sees on WhatsApp is unchanged for any promotion that never set
    // them, which was most of them.
    //
    // `promotions_whatsapp_shape` (`0040`) is satisfied either way: it requires
    // the two to be NULL when WhatsApp is off, and they are now always null.

    requestedFields: z.array(requestedField),
  })
  .superRefine((v, ctx) => {
    // promotions_window: strict, so a zero-length window cannot slip through.
    // One would accept nothing at any instant while reading as a real period.
    if (Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'The promotion must end after it starts.',
      });
    }

    // promotions_repetition_shape
    if (v.allowMultipleEntries && v.minHoursBetweenEntries === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minHoursBetweenEntries'],
        message: 'Say the least time that must pass between one listener’s entries.',
      });
    }
    if (!v.allowMultipleEntries && v.minHoursBetweenEntries !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minHoursBetweenEntries'],
        message: 'There is no interval to set while only one entry per listener is allowed.',
      });
    }

    // promotions_entry_ceiling_shape, the second half of it: the ceiling is
    // meaningful only where repeats are already allowed. There is deliberately
    // no matching "a repeatable promotion needs a ceiling" — unlike the
    // interval above, which the constraint does require, a promotion that
    // allows repeats without limit is the ordinary case.
    if (!v.allowMultipleEntries && v.maxEntriesPerMember !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxEntriesPerMember'],
        message: 'There is no ceiling to set while only one entry per listener is allowed.',
      });
    }

    // promotions_whatsapp_shape: the whole of the WhatsApp tab is empty when
    // WhatsApp is off, rather than merely ignored. A hashtag left behind on a
    // promotion that does not use WhatsApp is a value somebody will believe.
    if (v.whatsappEnabled && v.hashtag === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hashtag'],
        message: 'A WhatsApp promotion needs the hashtag the bot listens for.',
      });
    }
    // The banner is deliberately not checked here. It is not a field of this
    // form, and the rule that a promotion with WhatsApp off may not carry one is
    // enforced where it can actually be enforced: set_promotion_art refuses it
    // with a sentence, and update_promotion clears the column and queues the
    // object when WhatsApp is switched off (0144).
    //
    // Block 24 left the hashtag alone in what used to be a list of three. The
    // two button labels are no longer fields of this form either (see above), so
    // there is nothing to catch them arriving — and nothing that could send
    // them.
    if (!v.whatsappEnabled && v.hashtag !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hashtag'],
        message: 'Turn WhatsApp on for this promotion, or leave this empty.',
      });
    }

    // BLOCK 17c MOVED THIS OUT OF THE `!whatsappEnabled` BRANCH ABOVE, and the
    // move is the point. Requested fields used to belong to WhatsApp because
    // WhatsApp was the only thing that could ask a listener anything; the
    // widget asks the same fields through another door, so the rule is now
    // "some door", not "that door". promotions_conversational_shape (0171) says
    // the same in SQL.
    //
    // The hashtag and the button labels stay above, gated on WhatsApp alone:
    // they are objects of that conversation and of nothing else.
    if (!v.whatsappEnabled && !v.webEnabled && v.requestedFields.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedFields'],
        message: 'Turn WhatsApp or the web on for this promotion, or leave these empty.',
      });
    }

    // promotions_hashtag_shape. A hashtag with a space cannot be matched
    // against an inbound message with any confidence, and one without the
    // leading # is not what the operator types.
    if (v.hashtag !== undefined && !/^#[^\s#]{1,39}$/.test(v.hashtag)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hashtag'],
        message: 'Start the hashtag with # and use no spaces, up to 40 characters.',
      });
    }

    // promotions_art_shape and promotions_art_https were mirrored here until
    // Block 14, and both are gone for the same reason: there is no address on
    // this form to check. The tick and the field cannot disagree when there is
    // neither, and the https rule now protects nothing a client can influence —
    // the address is built on the server from the upload's own result.

    // promotions_requested_fields_distinct
    if (new Set(v.requestedFields).size !== v.requestedFields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedFields'],
        message: 'The same field is listed twice.',
      });
    }
  });

export type PromotionFormInput = z.infer<typeof promotionFormSchema>;

const questionOption = z.object({
  label: z.string().trim().min(1, 'Every option needs a label.').max(24),
  isCorrect: z.boolean(),
});

/**
 * Mirrors 0041 and save_promotion_question in 0043. The "exactly one right
 * answer" rule below is the one the database genuinely cannot hold: a partial
 * unique index forbids the SECOND correct option and nothing can require a
 * FIRST, so it exists here and in the RPC, and nowhere else.
 */
export const questionFormSchema = z
  .object({
    kind: z.enum(['QUIZ', 'MULTIPLE_CHOICE', 'ESSAY']),
    prompt: z.string().trim().min(1, 'Write the question.').max(300),

    // BLOCK 24 REMOVED `menuTitle` and `buttonLabel` (D3). They were the two
    // halves of the WhatsApp list message and the operator had to invent them
    // for every question.
    //
    // UNLIKE THE THREE PROMOTION FIELDS, THESE STILL HAVE TO BE WRITTEN.
    // `promotion_questions_list_fields` (`0041`) requires both to be present and
    // non-blank on every QUIZ and MULTIPLE_CHOICE, and `engine.ts` throws if
    // they reach it null. So `savePromotionQuestion` supplies
    // DEFAULT_QUESTION_MENU_TITLE and DEFAULT_QUESTION_BUTTON_LABEL at the door
    // — one place, rather than a constant in every caller.

    options: z.array(questionOption),
  })
  .superRefine((v, ctx) => {
    const correct = v.options.filter((o) => o.isCorrect).length;

    if (v.kind === 'ESSAY') {
      if (v.options.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'A written answer has no options to choose from.',
        });
      }
      return;
    }

    if (v.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A question with options needs at least two of them.',
      });
    }

    if (v.kind === 'QUIZ' && correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message:
          correct === 0
            ? 'Mark which option is the right answer.'
            : 'A quiz has one right answer, and more than one is marked.',
      });
    }

    if (v.kind === 'MULTIPLE_CHOICE' && correct > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A poll has no right answer. Make it a quiz, or unmark the option.',
      });
    }
  });

export type QuestionFormInput = z.infer<typeof questionFormSchema>;

/**
 * The Link and Unlink controls on the Prizes tab. Both post the same three
 * fields, and the direction is which action they post to rather than a flag in
 * the payload — a flag would make "unlink 5" and "link 5" one keystroke apart
 * in a form the operator cannot see.
 *
 * Every rule here has a refusal behind it in 0049, and that duplication is the
 * point rather than an oversight: this one gives the verdict on the screen
 * without a round trip, and the RPC gives it whether or not this ran.
 */
export const promotionPrizeLinkSchema = z.object({
  promotionId: z.string().uuid('Which promotion? Reopen the record.'),
  prizeId: z.string().uuid('Choose a prize.'),
  quantity: z
    .number({ invalid_type_error: 'How many units?' })
    .int('Units come in whole numbers.')
    .min(1, 'Link at least one unit.')
    // The upper bound is Postgres's, not a product rule: p_quantity on both
    // RPCs is `integer`, so 2147483648 — which the number input will not
    // produce but a hand-posted form will — never reaches a refusal that can
    // explain itself. It comes back as 22003, which maps to InternalError and
    // reaches the screen as a generic "Could not save". A sentence here is what
    // the operator gets instead. The RPCs' own floor (`<= 0`) has no ceiling to
    // pair with, because there is nothing sensible for one to say that this
    // does not say first.
    .max(2_147_483_647, 'That is more units than this system can count.'),
});

export type PromotionPrizeLinkInput = z.infer<typeof promotionPrizeLinkSchema>;
