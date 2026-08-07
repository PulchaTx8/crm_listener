import { z } from 'zod';

/**
 * The eight fields the bot may ask a listener for, in the order the WhatsApp
 * tab lists them and the order the bot asks them. Every marked field is asked
 * the same way: the owner was asked directly whether one would ever need
 * settings of its own — required versus optional, or its own place in the
 * queue — and said no (design spec D6). That answer is why this is a list on
 * the promotion rather than a table with a row per field.
 *
 * Each value names the `members` column it fills, not the label on screen. The
 * label is interface and will be reworded; the column is the contract.
 *
 * Three fields the owner's old system offered — gender, favourite station,
 * favourite show — are deliberately missing. They map to no column, and his
 * decision was that the new system will not have them (D5).
 */
export const REQUESTED_FIELD_ORDER = [
  'full_name',
  'address',
  'city',
  'neighbourhood',
  'age',
  'cpf',
  'passport',
  'discovery_source',
] as const;

export type RequestedField = (typeof REQUESTED_FIELD_ORDER)[number];

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

    callToAction: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

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

    yesButtonLabel: z
      .string()
      .trim()
      .max(20, 'Keep the button label to 20 characters or fewer.')
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),
    noButtonLabel: z
      .string()
      .trim()
      .max(20, 'Keep the button label to 20 characters or fewer.')
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

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
    if (!v.whatsappEnabled) {
      // The banner is deliberately not in this list any more. It is not a field
      // of this form, and the rule that a promotion with WhatsApp off may not
      // carry one is enforced where it can actually be enforced: set_promotion_art
      // refuses it with a sentence, and update_promotion clears the column and
      // queues the object when WhatsApp is switched off (0144).
      const stray = (
        [
          ['hashtag', v.hashtag],
          ['yesButtonLabel', v.yesButtonLabel],
          ['noButtonLabel', v.noButtonLabel],
        ] as const
      ).filter(([, value]) => value !== undefined);

      for (const [path] of stray) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: 'Turn WhatsApp on for this promotion, or leave this empty.',
        });
      }
      if (v.requestedFields.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedFields'],
          message: 'The bot only asks for these on a WhatsApp promotion.',
        });
      }
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

    // The two fields of the WhatsApp list message — what the owner's screen
    // calls Título do Menu and Título do Botão. WhatsApp caps the button at 20
    // characters and silently truncates past it, which reads as a bug in us.
    menuTitle: z
      .string()
      .trim()
      .max(24)
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),
    buttonLabel: z
      .string()
      .trim()
      .max(20, 'Keep the button label to 20 characters or fewer.')
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

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
      if (v.menuTitle !== undefined || v.buttonLabel !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['menuTitle'],
          message: 'A written answer shows no menu, so it needs no menu or button title.',
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

    if (v.menuTitle === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['menuTitle'],
        message: 'Title the menu the listener will see.',
      });
    }
    if (v.buttonLabel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonLabel'],
        message: 'Label the button that opens the menu.',
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
