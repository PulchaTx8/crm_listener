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

    requireCorrectAnswer: z.boolean(),

    whatsappEnabled: z.boolean(),

    hashtag: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

    useArt: z.boolean(),
    artUrl: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === null || v === '' ? undefined : v)),

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
      const stray = (
        [
          ['hashtag', v.hashtag],
          ['artUrl', v.artUrl],
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
      if (v.useArt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['useArt'],
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

    // promotions_art_shape: the tick and the field move together, so the row
    // can never say one thing and show another.
    if (v.useArt && v.artUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artUrl'],
        message: 'Give the address of the banner, or untick the image.',
      });
    }
    if (!v.useArt && v.artUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artUrl'],
        message: 'Tick the image to use a banner, or leave the address empty.',
      });
    }

    // promotions_art_https. WhatsApp fetches this image itself and will not
    // fetch over http; without this the failure surfaces at send time in
    // Block 5, where nothing points back to this field.
    if (v.artUrl !== undefined && !v.artUrl.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artUrl'],
        message: 'WhatsApp only fetches images over https, so the address must start with https://.',
      });
    }

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
