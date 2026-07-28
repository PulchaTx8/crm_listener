import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared field validators
//
// The convention every other schema in this directory already follows
// (prizeFormSchema's internalCode/description, roleFormSchema's description):
// blank, null and absent all collapse to the same `undefined`, so the RPC's
// own `nullif(trim(coalesce(p_x, '')), '')` (0034_member_rpcs.sql) never has
// to reconcile three spellings of "nothing here" coming from this layer.
// ---------------------------------------------------------------------------

function trimmedRequired(label: string, max: number) {
  return z.string().trim().min(1, `${label} is required.`).max(max);
}

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));
}

function optionalUuid() {
  return z
    .string()
    .uuid()
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? undefined : v));
}

// A blank/absent optional date field collapses to undefined before it ever
// reaches z.coerce.date() below — z.coerce.date() would otherwise try to
// parse '' or null as a date and fail with "Invalid date" instead of simply
// meaning "not supplied".
function blankToUndefined(v: unknown) {
  return v === null || v === '' || v === undefined ? undefined : v;
}

// A phone value that strips to no digits at all is not "no phone" — it is
// meaningless input someone typed by mistake ("----", punctuation only). The
// database's own public.normalize_phone (0031_members.sql) would collapse
// that same string to NULL just as happily as it collapses a genuinely blank
// field, so nothing downstream would ever catch the difference; this schema
// is where "no digits at all" gets refused instead of silently accepted as
// "no phone". Blank/absent itself stays a legitimate "no phone" — the two
// cases are different inputs and must not share a verdict.
const phone = z.preprocess(
  (v) => (typeof v === 'string' ? blankToUndefined(v.trim()) : blankToUndefined(v)),
  z
    .string()
    .max(40, 'Keep the phone number to 40 characters or fewer.')
    .refine((v) => /[0-9]/.test(v), 'Enter a valid phone number, or leave it blank.')
    .optional(),
);

// Bounded to RFC 5321's 320-character limit — the same bound
// schemas/invitations.ts uses for its own (mandatory) e-mail field — and
// lower-cased here before it ever reaches public.normalize_email (0031):
// the database would lower-case it anyway for email_normalized, but a value
// that already agrees with what gets stored is one less thing for a screen
// to reconcile.
const email = z.preprocess(
  (v) => (typeof v === 'string' ? blankToUndefined(v.trim().toLowerCase()) : blankToUndefined(v)),
  z
    .string()
    .max(320, 'Keep the e-mail address to 320 characters or fewer.')
    .email('Enter a valid e-mail address.')
    .optional(),
);

// The raw CPF, stripped to digits so the same value written
// "123.456.789-09" or "12345678909" reaches services/members.ts as one
// canonical eleven-digit string — hashing itself happens there (node:crypto),
// never here and never in the database (0031's own comment on cpf_hash: "the
// raw number is stored nowhere"). This schema's job is only to catch a value
// that is not eleven digits before a round trip is spent on it.
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

// birth_date is a Postgres `date` (0031_members.sql). The refine below reads
// Date.now() at parse time, not at module load — a schema file is imported
// once per process, so pinning "now" to a module-level constant would make
// this check stale for the lifetime of the server.
const birthDate = z.preprocess(
  blankToUndefined,
  z
    .coerce.date()
    .optional()
    .refine((v) => v === undefined || v.getTime() <= Date.now(), {
      message: 'The birth date cannot be in the future.',
    }),
);

const optionalTimestamp = z.preprocess(blankToUndefined, z.coerce.date().optional());

const addressFields = {
  addressLine: optionalText(200),
  addressNumber: optionalText(20),
  addressComplement: optionalText(200),
  neighbourhood: optionalText(120),
  city: optionalText(120),
  state: optionalText(100),
  postalCode: optionalText(20),
};

// Shared by createMemberSchema and updateMemberSchema: every field
// create_member and update_member (0034_member_rpcs.sql) both accept, in the
// shape each RPC actually declares. Both RPCs take eight consecutive `text`
// parameters — this task's own analysis, not a warning 0034 states itself:
// a single omitted positional argument would shift every later value one
// column left with no type error possible. This schema is what keeps the
// field-to-name mapping honest on the way in: every value below is read by
// its property name, never by position, and services/members.ts carries the
// same rule forward into the two RPC calls themselves (named arguments
// only, never positional).
const memberIdentityFields = {
  fullName: z.string().trim().min(1, 'Name the listener.').max(200),
  phone,
  email,
  cpf,
  passport: optionalText(40),
  birthDate,
  ...addressFields,
  discoverySource: optionalText(200),
};

// Mirrors create_member (0034): the identity fields above, the Station being
// registered at, and the first-contact evidence behind the owner's
// WhatsApp-consent ruling (spec §7).
export const createMemberSchema = z.object({
  companyId: z.string().uuid(),
  ...memberIdentityFields,
  firstContactAt: optionalTimestamp,
  firstContactOrigin: optionalText(200),
});

// Mirrors update_member (0034): a wholesale replacement of the same
// identity fields, keyed on the Member rather than the Station.
// firstContactAt/firstContactOrigin are deliberately absent, not merely
// unset — update_member's own comment explains why: they are the evidence
// behind the owner's WhatsApp-consent ruling (spec §7), write-once through
// create_member and correctable by nothing, so a later edit must not be able
// to rewrite evidence for a position already taken. This schema cannot
// express what create_member's schema can for those two fields; that is
// deliberate, not an oversight.
export const updateMemberSchema = z.object({
  memberId: z.string().uuid(),
  ...memberIdentityFields,
});

export const linkMemberToCompanySchema = z.object({
  memberId: z.string().uuid(),
  companyId: z.string().uuid(),
});

// consent_type mirrors public.member_consent_type (0032_member_lifecycle_tables.sql)
// exactly — the three consents decision 2 fixed. There is no fourth value:
// WhatsApp consent is deliberately absent, evidenced instead by
// members.first_contact_at/first_contact_origin (decision 3).
export const recordMemberConsentSchema = z.object({
  memberId: z.string().uuid(),
  companyId: z.string().uuid(),
  consentType: z.enum(['rules', 'image_use', 'sponsor_communication']),
  granted: z.boolean(),
  origin: optionalText(500),
  promotionId: optionalUuid(),
});

export const addMemberNoteSchema = z.object({
  memberId: z.string().uuid(),
  companyId: z.string().uuid(),
  body: trimmedRequired('A note', 4000),
});

// kind mirrors public.member_block_kind (0032); companyId absent means an
// Organization-wide block (block_member's own p_company_id default null,
// 0034) rather than one scoped to a single Station.
export const blockMemberSchema = z.object({
  memberId: z.string().uuid(),
  kind: z.enum(['draw_ban', 'suspension']),
  reason: trimmedRequired('A reason', 2000),
  companyId: optionalUuid(),
  endsAt: optionalTimestamp,
});

export const liftMemberBlockSchema = z.object({
  blockId: z.string().uuid(),
  reason: trimmedRequired('A reason', 2000),
});

// The registration form's own pre-submission dedup check (Task 9) — the same
// four identifying fields find_member_by_identifier (0033) accepts, validated
// the same way createMemberSchema's identity fields are before any of them
// reach a network call. find_member_by_identifier's own guard ("give at least
// one identifier to search by", 22023) is the backstop this refine mirrors —
// mirrors, not replaces: a caller that reaches the RPC with all four blank
// (this schema bypassed some other way) is still refused there.
export const findMemberByIdentifierSchema = z
  .object({ phone, email, cpf, passport: optionalText(40) })
  .refine((v) => Boolean(v.phone || v.email || v.cpf || v.passport), {
    message: 'Enter at least one of phone, e-mail, CPF or passport to check.',
  });

// public.member_erasure_reason (0034) — subject_request | court_order |
// internal_policy, deliberately no `other` (owner's ruling: an escape hatch
// would invite back exactly the free text about a person this ruling exists
// to keep out of an immutable audit trail). No fourth value this schema can
// express, matching the enum it mirrors.
export const anonymizeMemberSchema = z.object({
  memberId: z.string().uuid(),
  reason: z.enum(['subject_request', 'court_order', 'internal_policy']),
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type LinkMemberToCompanyInput = z.infer<typeof linkMemberToCompanySchema>;
export type RecordMemberConsentInput = z.infer<typeof recordMemberConsentSchema>;
export type AddMemberNoteInput = z.infer<typeof addMemberNoteSchema>;
export type BlockMemberInput = z.infer<typeof blockMemberSchema>;
export type LiftMemberBlockInput = z.infer<typeof liftMemberBlockSchema>;
export type FindMemberByIdentifierFormInput = z.infer<typeof findMemberByIdentifierSchema>;
export type AnonymizeMemberInput = z.infer<typeof anonymizeMemberSchema>;
