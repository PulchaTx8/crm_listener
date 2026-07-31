import { z } from 'zod';

// ---------------------------------------------------------------------------
// Two ways one participation is described: what an operator types into the
// manual form, and what one line of an imported file says.
//
// Both feed the same mechanics — apply_participation (0054) is shared by
// record_participation and import_participations so the two doors cannot drift
// — but they are deliberately NOT one schema. A form is one person the operator
// can be asked to correct; a file is six hundred rows that must be reported on
// per line. The rules where they differ are marked below, each with the reason.
// ---------------------------------------------------------------------------

/**
 * Blank, null and absent all collapse to the same `undefined`, the convention
 * every other schema in this directory follows: the RPCs' own
 * `nullif(btrim(coalesce(p_x, '')), '')` never has to reconcile three spellings
 * of "nothing here" coming from this layer.
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));
}

/**
 * A phone that strips to no digits at all is not "no phone" — it is punctuation
 * somebody typed by mistake, and public.normalize_phone (0031) would collapse it
 * to NULL as happily as it collapses a genuinely blank field, so nothing
 * downstream could ever catch the difference.
 *
 * Re-declared here rather than shared with schemas/members.ts, which holds the
 * identical rule. Every schema in this directory declares its own field helpers
 * (roleFormSchema's description, prizeFormSchema's internalCode,
 * memberIdentityFields), and the alternative — exporting members.ts's private
 * validators — would make a module three member screens depend on carry a
 * surface it does not use. What must never be duplicated is the NORMALISATION,
 * and it is not: the digits that reach the database are produced by
 * services/members.ts's normalizeCpf/hashCpf, which services/participations.ts
 * calls rather than reimplements (0031's own warning).
 */
function blankToUndefined(v: unknown) {
  return v === null || v === '' || v === undefined ? undefined : v;
}

const phone = z.preprocess(
  (v) => (typeof v === 'string' ? blankToUndefined(v.trim()) : blankToUndefined(v)),
  z
    .string()
    .max(40, 'Keep the phone number to 40 characters or fewer.')
    .refine((v) => /[0-9]/.test(v), 'Enter a valid phone number, or leave it blank.')
    .optional(),
);

/**
 * The raw CPF, stripped to digits so "123.456.789-09" and "12345678909" are one
 * canonical value. Hashing happens in services/participations.ts (node:crypto),
 * never here and never in the database — 0031's own comment on cpf_hash: the raw
 * number is stored nowhere and appears in no query log. This schema's only job
 * is to catch a value that is not eleven digits before a round trip is spent on
 * it, and before it reaches 0031's `cpf_hash ~ '^[0-9a-f]{64}$'` check as a
 * hash of nonsense.
 */
const cpf = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return blankToUndefined(v);
    const digits = v.replace(/[^0-9]/g, '');
    return digits === '' ? undefined : digits;
  },
  z
    .string()
    .regex(/^[0-9]{11}$/, 'A CPF has eleven digits.')
    .optional(),
);

/**
 * One answer to one question, mirroring participation_answers_shape (0052):
 * a chosen option for a QUIZ or a poll, written text for an essay, and never
 * both or neither.
 *
 * The check cannot consult the question's kind, because the payload does not
 * carry one — apply_participation reads the kind off promotion_questions so a
 * caller cannot claim a question is something it is not. What is left is
 * exactly what the CHECK amounts to from this side: one of the two, never the
 * pair. Without it the row reaches Postgres, trips the constraint, and comes
 * back as a bare 23514 naming a constraint the operator has never heard of.
 */
const participationAnswer = z
  .object({
    questionId: z.string().uuid('Which question? Reopen the form.'),
    optionId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .transform((v) => (v === null || v === undefined ? undefined : v)),
    answerText: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.optionId !== undefined && v.answerText !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answerText'],
        message: 'An answer is either a chosen option or written text, never both.',
      });
    }
    if (v.optionId === undefined && v.answerText === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionId'],
        message: 'Choose an option, or write the answer.',
      });
    }
  });

export type ParticipationAnswerInput = z.infer<typeof participationAnswer>;

/**
 * The manual form. Two ways in, and the difference is `memberId`: the operator
 * either picked somebody from the search box — in which case the listener is
 * already resolved and there is nothing left to identify them by — or typed
 * their details, and resolve_or_create_member (0054) finds or registers them
 * (design spec D4/§5).
 *
 * `participatedAt` is an instant, converted from the operator's local input in
 * the BROWSER before it reaches here, the same rule schemas/members.ts states at
 * length for its own timestamps: a naive, offset-less string parsed on the
 * server would succeed at the wrong instant, and nothing at this layer could
 * catch it. D7 is why that matters here in particular — the minimum interval
 * measures against this value, not against when the row was written.
 */
export const participationFormSchema = z
  .object({
    promotionId: z.string().uuid('Which promotion? Reopen the form.'),

    memberId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .transform((v) => (v === null || v === undefined ? undefined : v)),

    fullName: optionalText(200),
    phone,
    cpf,

    participatedAt: z.string().datetime({
      offset: true,
      message: 'Say when this person entered.',
    }),

    answers: z.array(participationAnswer),
  })
  .superRefine((v, ctx) => {
    if (v.memberId !== undefined) return;

    if (v.fullName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fullName'],
        message: 'Name the listener.',
      });
    }

    // resolve_or_create_member REGISTERS the listener when it finds none, so a
    // form with neither identifier does not fail — it quietly creates a fresh
    // listener on every submission, none of which can ever be deduplicated
    // against, because 0031's unique indexes are on phone, e-mail, CPF and
    // passport and a row with none of them collides with nothing. The refusal
    // belongs here rather than in the RPC for the reason the RPC's own
    // `elsewhere` branch does not: this is a single person in front of an
    // operator who can be asked to supply one field.
    if (v.phone === undefined && v.cpf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'Enter a phone number or a CPF so the listener can be found or registered.',
      });
    }
  });

export type ParticipationFormInput = z.infer<typeof participationFormSchema>;

/**
 * One line of the imported file, after the header has been mapped. The four
 * columns of D7 — a name, a phone and/or a CPF, and when the person entered —
 * plus the line number they came from, so the result the RPC returns can be
 * shown against the file the operator is looking at.
 *
 * The field names here are English because every identifier in this project is;
 * the CSV's own header row is the operator's Portuguese and is mapped to these
 * by the import form, which shows that mapping back before it writes anything
 * (design spec §6).
 *
 * NOTE the one rule this schema deliberately does NOT carry, against every
 * instinct to mirror the RPC: a row with neither a phone nor a CPF is accepted.
 * import_participations skips exactly that row and reports it with its line and
 * the reason "no identifier". Refusing it here would make that branch
 * unreachable through the screen and would replace a per-line report — which is
 * the whole point of D6's one-step import — with a wall of validation errors.
 * The manual form above refuses the same shape, and the asymmetry is the
 * difference between one person and six hundred.
 */
export const importRowSchema = z.object({
  // The line the row came from, echoed back by the RPC. Bounded at Postgres's
  // integer ceiling because import_participations casts it with
  // `(v_row ->> 'line')::integer`: a larger number comes back as 22003, which
  // maps to InternalError and reaches the operator as a generic failure with
  // nothing to act on. Same reasoning promotionPrizeLinkSchema's own upper bound
  // carries, and the same lesson.
  line: z
    .number({ invalid_type_error: 'Which line of the file is this?' })
    .int('A line number is a whole number.')
    .min(1, 'Line numbers start at one.')
    .max(2_147_483_647, 'That is a longer file than this system can count.'),

  // Required, unlike the identifiers. A row that has to REGISTER its listener
  // reaches create_member (0034), which raises 22023 for a blank name — and it
  // does so in the middle of the file, aborting the whole call after some rows
  // are already written. Refused here instead, so the operator fixes a line
  // before anything is written rather than after half of it was.
  fullName: z.string().trim().min(1, 'This row has no name.').max(200),

  phone,
  cpf,

  // D7: the timestamp is not decoration. The minimum interval measures against
  // it, so a spreadsheet of last month's entries stamped "now" would refuse its
  // own second entry for a person and give a reason that is not true. An
  // instant, not a local date-time: the import form converts the file's own
  // format in the browser, using the Station's zone, exactly as the manual form
  // does — the alternative, parsing "01/08/2026 14:30" here, would read it in
  // whatever zone this server process happens to run in and be silently wrong.
  participatedAt: z.string().datetime({
    offset: true,
    message: 'Could not read when this person entered.',
  }),
});

export type ImportRowInput = z.infer<typeof importRowSchema>;
