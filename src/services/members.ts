import 'server-only';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  BusinessRuleError,
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';
import type {
  AddMemberNoteInput,
  BlockMemberInput,
  CreateMemberInput,
  LiftMemberBlockInput,
  LinkMemberToCompanyInput,
  RecordMemberConsentInput,
  UpdateMemberInput,
} from '@/schemas/members';

export type MemberConsentType = Database['public']['Enums']['member_consent_type'];
export type MemberBlockKind = Database['public']['Enums']['member_block_kind'];
export type MemberErasureReason = Database['public']['Enums']['member_erasure_reason'];

/**
 * A client bound to the caller's JWT. Every RPC in 0033/0034 re-checks the
 * caller's own permission against auth.uid() inside a SECURITY DEFINER (or,
 * for member_reachable, SECURITY INVOKER) body, so calling one with the
 * service key would defeat the check it exists to make — the same reasoning
 * services/inventory.ts and services/roles.ts give for their own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// The CPF, hashed here and only here.
//
// The raw CPF must never reach the database (0031_members.sql's own comment
// on cpf_hash: "the raw number is stored nowhere and appears in no query
// log"; its cpf_hash CHECK, `~ '^[0-9a-f]{64}$'`, backs that structurally by
// refusing an eleven-digit raw CPF outright). This file hashes it in Node
// with node:crypto before a value ever reaches an RPC argument — exactly the
// same reasoning services/invitations.ts gives for hashing an invitation
// token client-side: an argument passed to an RPC lands in query logs and in
// backups, so the value that must never appear there must never be sent.
// ---------------------------------------------------------------------------

/** Digits only. "123.456.789-09" and "12345678909" both normalise to the same string. */
export function normalizeCpf(rawCpf: string): string {
  return rawCpf.replace(/[^0-9]/g, '');
}

/**
 * SHA-256 of the normalised CPF. Two spellings of the same number therefore
 * hash identically — the equality 0031's cpf_hash unique index (and
 * find_member_by_identifier, 0033) depends on to deduplicate at all.
 */
export function hashCpf(rawCpf: string): string {
  return createHash('sha256').update(normalizeCpf(rawCpf)).digest('hex');
}

/** The last three digits — cpf_last_digits' own format (0031): what a person confirms out loud. */
export function cpfLastDigits(rawCpf: string): string {
  return normalizeCpf(rawCpf).slice(-3);
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FindMemberByIdentifierInput {
  organizationId: string;
  phone?: string;
  email?: string;
  /** Raw CPF — hashed here before the RPC ever sees it, same as create/updateMember. */
  cpf?: string;
  passport?: string;
}

/**
 * The three, and only three, answers 0033_member_dedup.sql's function is
 * allowed to give (spec §4): no match; a match the caller may see, with its
 * id; a match the caller may not see, with nothing else. The union type is
 * what makes a caller that reaches into the `elsewhere` branch for a
 * `memberId` that was never returned a compile error instead of `undefined`
 * discovered at runtime.
 */
export type FindMemberByIdentifierResult =
  | { outcome: 'none' }
  | { outcome: 'visible'; memberId: string }
  | { outcome: 'elsewhere' };

function parseFindMemberByIdentifierResult(data: unknown): FindMemberByIdentifierResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('find_member_by_identifier returned an unexpected shape');
  }
  const row = data as Record<string, unknown>;
  if (row.outcome === 'none') return { outcome: 'none' };
  if (row.outcome === 'elsewhere') return { outcome: 'elsewhere' };
  if (row.outcome === 'visible') {
    if (typeof row.member_id !== 'string') {
      throw new InternalError('find_member_by_identifier returned "visible" with no member_id');
    }
    return { outcome: 'visible', memberId: row.member_id };
  }
  throw new InternalError(
    `find_member_by_identifier returned an unrecognised outcome: ${String(row.outcome)}`,
  );
}

/**
 * The friendly, cross-visibility duplicate check (spec §4, 0033's own
 * comment: "the one place in this project that reads across the visibility
 * boundary by design"). A read, and its error is surfaced like any other —
 * a caller that cannot tell a failed lookup from a genuine "no match" would
 * register a duplicate believing it had already checked.
 */
export async function findMemberByIdentifier(
  input: FindMemberByIdentifierInput,
  accessToken: string,
): Promise<FindMemberByIdentifierResult> {
  const { data, error } = await asCaller(accessToken).rpc('find_member_by_identifier', {
    p_organization_id: input.organizationId,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_passport: input.passport,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return parseFindMemberByIdentifierResult(data);
}

/**
 * Whether an active block bars this Member at this Station right now
 * (is_member_blocked, 0032) — a block with a past ends_at no longer counts,
 * one with no ends_at always does, derived at read time rather than from a
 * status column nothing maintains. A read; its error is surfaced, not
 * swallowed into a false "not blocked".
 */
export async function isMemberBlocked(
  memberId: string,
  companyId: string,
  accessToken: string,
): Promise<boolean> {
  const { data, error } = await asCaller(accessToken).rpc('is_member_blocked', {
    p_member_id: memberId,
    p_company_id: companyId,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data;
}

/**
 * Whether the caller holds p_permission at any Station this Member is linked
 * to (member_reachable, 0033) — admits the owner and the platform admin
 * outside the per-link check, so a Member whose only Station is archived is
 * not a permanent dead end. A read; its error is surfaced, not swallowed.
 */
export async function memberReachable(
  memberId: string,
  organizationId: string,
  permission: string,
  accessToken: string,
): Promise<boolean> {
  const { data, error } = await asCaller(accessToken).rpc('member_reachable', {
    p_member_id: memberId,
    p_organization_id: organizationId,
    p_permission: permission,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data;
}

// ---------------------------------------------------------------------------
// create_member / update_member — named arguments only, never positional.
//
// Both RPCs (0034_member_rpcs.sql) take eight consecutive `text` parameters
// — this task's own analysis, not a warning 0034 states itself: a single
// omitted positional argument would shift every later value one column left
// with no type error possible. Supabase's JS client already forces every
// .rpc() call through an object keyed by parameter name rather than a
// positional array, so that shift-by-one hazard cannot occur through this
// client the way it could through a raw positional
// `select create_member($1, $2, ...)`. The object literals below keep that
// guarantee visible rather than incidental: every field is spelled out by
// its `p_` name, in the RPC's own declared names, not assembled from an
// array or spread from a tuple that could silently drop or reorder one.
// ---------------------------------------------------------------------------

export async function createMember(input: CreateMemberInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_member', {
    p_company_id: input.companyId,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_cpf_last_digits: input.cpf ? cpfLastDigits(input.cpf) : undefined,
    p_passport: input.passport,
    p_birth_date: input.birthDate ? toDateOnly(input.birthDate) : undefined,
    p_address_line: input.addressLine,
    p_address_number: input.addressNumber,
    p_address_complement: input.addressComplement,
    p_neighbourhood: input.neighbourhood,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_discovery_source: input.discoverySource,
    p_first_contact_at: input.firstContactAt ? input.firstContactAt.toISOString() : undefined,
    p_first_contact_origin: input.firstContactOrigin,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_member returned no id');
  return data;
}

export async function updateMember(input: UpdateMemberInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_member', {
    p_member_id: input.memberId,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_cpf_last_digits: input.cpf ? cpfLastDigits(input.cpf) : undefined,
    p_passport: input.passport,
    p_birth_date: input.birthDate ? toDateOnly(input.birthDate) : undefined,
    p_address_line: input.addressLine,
    p_address_number: input.addressNumber,
    p_address_complement: input.addressComplement,
    p_neighbourhood: input.neighbourhood,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_discovery_source: input.discoverySource,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function linkMemberToCompany(
  input: LinkMemberToCompanyInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('link_member_to_company', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function archiveMember(memberId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_member', { p_member_id: memberId });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function recordMemberConsent(
  input: RecordMemberConsentInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_member_consent', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
    p_consent_type: input.consentType,
    p_granted: input.granted,
    p_origin: input.origin,
    p_promotion_id: input.promotionId,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_member_consent returned no id');
  return data;
}

export async function addMemberNote(input: AddMemberNoteInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('add_member_note', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
    p_body: input.body,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('add_member_note returned no id');
  return data;
}

export async function blockMember(input: BlockMemberInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('block_member', {
    p_member_id: input.memberId,
    p_kind: input.kind,
    p_reason: input.reason,
    p_company_id: input.companyId,
    p_ends_at: input.endsAt ? input.endsAt.toISOString() : undefined,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('block_member returned no id');
  return data;
}

export async function liftMemberBlock(input: LiftMemberBlockInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('lift_member_block', {
    p_block_id: input.blockId,
    p_reason: input.reason,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

/**
 * LGPD erasure (spec §7). p_reason is public.member_erasure_reason — a
 * bounded enum (subject_request | court_order | internal_policy), not text:
 * the owner's ruling (0034's own comment) is that an escape hatch such as
 * `other` would invite back exactly the free text about a person that this
 * ruling exists to keep out of an immutable audit trail. MemberErasureReason
 * is the generated union of those three literals — there is no fourth value
 * this function's TypeScript signature can express, which is deliberate.
 */
export async function anonymizeMember(
  memberId: string,
  reason: MemberErasureReason,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('anonymize_member', {
    p_member_id: memberId,
    p_reason: reason,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

/**
 * The error taxonomy in lib/errors.ts exists so a caller can tell these
 * apart; collapsing them into one class throws that away, the same warning
 * services/inventory.ts's mapInventoryError and services/roles.ts's
 * mapRoleError both carry.
 *
 * - `23505` is any of the four partial unique indexes on members (phone,
 *   e-mail, CPF hash, passport — 0031_members.sql) colliding in
 *   create_member/update_member, or a listener already linked to a Station
 *   in link_member_to_company. create_member/update_member catch the raw
 *   unique_violation and rewrite it to name the field categories that could
 *   have collided (phone, e-mail, CPF or passport) — deliberately not which
 *   one, the owner's ruling against per-identifier resolution (0033's own
 *   comment: resolving per-identifier "was deliberately rejected, because it
 *   would ripple into Tasks 6 and 9"). link_member_to_company's own message
 *   is precise, because it has only one possible cause: this exact pair is
 *   already linked.
 * - `P0002` is every "not found" raise across 0033/0034 — a stale
 *   Station/member/block id, or a listener already archived or anonymised.
 *   Not a permission refusal: the row is simply gone, and telling someone
 *   they lack permission when the record no longer exists sends them to fix
 *   the wrong thing.
 * - `42501` is has_permission/has_org_permission/member_reachable failing
 *   inside a SECURITY DEFINER body — every RPC in 0033/0034 raises this with
 *   the same shape, having already written a RAISE LOG line server-side.
 * - `22023` is every application-level validation and state raise across
 *   0033/0034 that chose this code: a blank name, a missing consent type,
 *   granted flag or block kind, a blank note/reason, find_member_by_
 *   identifier's "give at least one identifier" guard, and — easy to mistake
 *   for a permission refusal — update_member's own distinct messages for
 *   editing an already-archived or an already-anonymised listener (0034's
 *   own comment explains why it re-reads to tell the two apart rather than
 *   guessing). schemas/members.ts catches the field-level cases before a
 *   request is ever sent; this mapping is what still applies to those, and
 *   is the only thing that catches the state-conflict cases at all, since no
 *   client-side schema can know a row was archived after the form loaded.
 * - `23503` is a foreign key violation. Unlike inventory.ts's own use of this
 *   code (archive_prize's explicit `raise ... using errcode = '23503'` for a
 *   prize still in stock), none of 0033/0034's RAISE statements use it —
 *   there is no application-level business rule raising it here. It is
 *   mapped anyway, per this task's own instruction, as a forward-looking
 *   defensive case: member_consents.promotion_id (0032) carries no foreign
 *   key yet ("public.promotions does not exist" — 0032's own comment) and
 *   the three composite FKs record_member_consent/add_member_note/
 *   block_member do write against (member_consents_company_org_fk,
 *   member_notes_company_org_fk, member_blocks_company_org_fk, 0032) cannot
 *   currently fail in normal operation, because nothing in this codebase
 *   hard-deletes a company or a member (archive_member's own comment) — the
 *   row a member_company_links entry already proved exists
 *   (member_linked_to_company, 0034) never disappears out from under it. If
 *   promotion_id's foreign key is added later, or a future migration
 *   introduces a real deletion path, this mapping is already correct rather
 *   than silently swallowing the new failure as an InternalError.
 * - `22P02` is what casting an out-of-vocabulary string to
 *   public.member_erasure_reason (anonymize_member's p_reason) raises —
 *   Postgres's own "invalid input value for enum" failure, not one this
 *   project's SQL wrote. anonymizeMember's own TypeScript signature only
 *   accepts the three literal values the enum declares, so this cannot fire
 *   through that function honestly typed — but a caller who bypasses the
 *   type system (an `as` cast over untrusted external input, for instance)
 *   can still reach it, and record_member_consent/block_member's own enum
 *   parameters carry the identical risk. Same SQLSTATE class as `22023`
 *   (class 22, "Data Exception") and the same verdict: the caller supplied a
 *   value that does not parse as what was asked for. That is what
 *   ValidationError means here — the value is wrong, not the request itself,
 *   and not a server fault.
 * - Anything else is ours, not the caller's. Labelling an unexpected
 *   database fault a refusal hides a real fault behind a plausible-looking
 *   permission or business-rule message.
 */
function mapMemberError(code: string | undefined, message: string): Error {
  if (code === '23505') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  if (code === '22P02') return new ValidationError(message);
  if (code === '23503') return new BusinessRuleError(message);
  return new InternalError(message);
}
