'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import {
  anonymizeMemberSchema,
  blockMemberSchema,
  createMemberSchema,
  findMemberByIdentifierSchema,
  linkMemberToCompanySchema,
  liftMemberBlockSchema,
  recordMemberConsentSchema,
} from '@/schemas/members';
import {
  anonymizeMember,
  blockMember,
  createMember,
  findMemberByIdentifier,
  linkMemberToCompany,
  liftMemberBlock,
  recordMemberConsent,
} from '@/services/members';
import { logger } from '@/lib/logger';
import { describeMembersWriteError } from './errors';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

// find_member_by_identifier (0033) is Organization-scoped, not Station-scoped
// — the one action on this surface that needs the caller's organizationId
// rather than just their access token. Resolved the same way page.tsx resolves
// it for the list screen: the caller's first live organization_membership, not
// a value trusted from the client.
async function requireCallerContext(): Promise<{ accessToken: string; organizationId: string }> {
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect('/login');

  const { data: memberships } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  const organizationId = memberships?.[0]?.organization_id;
  if (!organizationId) redirect('/app');

  return { accessToken, organizationId };
}

// ---------------------------------------------------------------------------
// Registration — members.create. The dedup check and the actual registration
// are deliberately two separate actions, not one: the brief's own requirement
// is that the person SEES one of find_member_by_identifier's three answers
// before anything is submitted, not that the answer is checked internally on
// the way to a write. register-member-form.tsx calls checkMemberIdentifierAction
// first and only reveals the rest of the form (and registerMemberAction) once
// that check has come back 'none'.
// ---------------------------------------------------------------------------

export type CheckIdentifierState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'checked'; outcome: 'none' }
  | { status: 'checked'; outcome: 'visible'; memberId: string }
  | { status: 'checked'; outcome: 'elsewhere' };

export async function checkMemberIdentifierAction(
  _prev: CheckIdentifierState,
  formData: FormData,
): Promise<CheckIdentifierState> {
  const parsed = findMemberByIdentifierSchema.safeParse({
    phone: formData.get('phone'),
    email: formData.get('email'),
    cpf: formData.get('cpf'),
    passport: formData.get('passport'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const { accessToken, organizationId } = await requireCallerContext();

  try {
    const result = await findMemberByIdentifier(
      { organizationId, ...parsed.data },
      accessToken,
    );
    if (result.outcome === 'visible') {
      return { status: 'checked', outcome: 'visible', memberId: result.memberId };
    }
    return { status: 'checked', outcome: result.outcome };
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'check member identifier failed');
    return {
      status: 'error',
      message: describeMembersWriteError(cause, 'check for an existing listener'),
    };
  }
}

export interface RegisterMemberState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  memberId?: string;
}

export async function registerMemberAction(
  _prev: RegisterMemberState,
  formData: FormData,
): Promise<RegisterMemberState> {
  const parsed = createMemberSchema.safeParse({
    companyId: formData.get('companyId'),
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    cpf: formData.get('cpf'),
    passport: formData.get('passport'),
    birthDate: formData.get('birthDate') || null,
    addressLine: formData.get('addressLine'),
    addressNumber: formData.get('addressNumber'),
    addressComplement: formData.get('addressComplement'),
    neighbourhood: formData.get('neighbourhood'),
    city: formData.get('city'),
    state: formData.get('state'),
    postalCode: formData.get('postalCode'),
    discoverySource: formData.get('discoverySource'),
    firstContactAt: formData.get('firstContactAt') || null,
    firstContactOrigin: formData.get('firstContactOrigin'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const memberId = await createMember(parsed.data, token);
    revalidatePath('/members');
    return { status: 'saved', memberId };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'register member failed');
    return { status: 'error', message: describeMembersWriteError(cause, 'register a listener') };
  }
}

export interface LinkMemberState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

/**
 * The 'visible' outcome's own action — spec §4: "the screen offers to open
 * the existing record." Opening it is a plain Link (register-member-form.tsx),
 * needing no server round trip; this is the second half a registration
 * workflow actually needs: the person came here to add this listener to a
 * specific Station, and a match they can already see may not yet be linked to
 * THIS one. link_member_to_company (0034) is idempotent-refusing, not
 * idempotent-succeeding — a pair already linked comes back as a named 23505,
 * surfaced by describeMembersWriteError like any other conflict, not hidden.
 */
export async function linkMemberToStationAction(
  _prev: LinkMemberState,
  formData: FormData,
): Promise<LinkMemberState> {
  const parsed = linkMemberToCompanySchema.safeParse({
    memberId: formData.get('memberId'),
    companyId: formData.get('companyId'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await linkMemberToCompany(parsed.data, token);
    revalidatePath('/members');
    revalidatePath(`/members/${parsed.data.memberId}`);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, memberId: parsed.data.memberId }, 'link member to station failed');
    return {
      status: 'error',
      message: describeMembersWriteError(cause, 'link this listener to a Station'),
    };
  }
}

// ---------------------------------------------------------------------------
// Consent — members.edit
// ---------------------------------------------------------------------------

export interface ConsentFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function recordConsentAction(
  _prev: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const parsed = recordMemberConsentSchema.safeParse({
    memberId: formData.get('memberId'),
    companyId: formData.get('companyId'),
    consentType: formData.get('consentType'),
    granted: formData.get('granted') === 'true',
    origin: formData.get('origin'),
    // Promotions do not exist yet (0032's own comment on member_consents.promotion_id)
    // — never collected from this form.
    promotionId: null,
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await recordMemberConsent(parsed.data, token);
    revalidatePath(`/members/${parsed.data.memberId}`);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, memberId: parsed.data.memberId }, 'record member consent failed');
    return { status: 'error', message: describeMembersWriteError(cause, 'record this consent') };
  }
}

// add_member_note (0034) has no form in this task: the brief names
// registration, consent, blocking and erasure, not notes — Task 8 already
// reads member_notes for display; writing them is left for whichever later
// task actually calls for that screen, rather than half-built here.

// ---------------------------------------------------------------------------
// Blocking — members.block. Two write RPCs, one screen surface: creating a
// block and lifting one are both "blocking" in the brief's own word for this
// task, and a block history with no way to ever lift an indefinite block
// would be a dead end this task exists to avoid creating.
// ---------------------------------------------------------------------------

export interface BlockFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function blockMemberAction(
  _prev: BlockFormState,
  formData: FormData,
): Promise<BlockFormState> {
  const parsed = blockMemberSchema.safeParse({
    memberId: formData.get('memberId'),
    kind: formData.get('kind'),
    reason: formData.get('reason'),
    // "" (the Select's own "Whole Organization" option) means Organization-wide
    // — block_member's own p_company_id default null (0034) — not a missing
    // Station, so it is folded to null here rather than left as an empty
    // string optionalUuid() would reject as an invalid uuid.
    companyId: formData.get('companyId') || null,
    endsAt: formData.get('endsAt') || null,
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await blockMember(parsed.data, token);
    revalidatePath(`/members/${parsed.data.memberId}`);
    revalidatePath('/members');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, memberId: parsed.data.memberId }, 'block member failed');
    return { status: 'error', message: describeMembersWriteError(cause, 'block this listener') };
  }
}

export interface LiftBlockFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function liftMemberBlockAction(
  _prev: LiftBlockFormState,
  formData: FormData,
): Promise<LiftBlockFormState> {
  const parsed = liftMemberBlockSchema.safeParse({
    blockId: formData.get('blockId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  // memberId is not a lift_member_block argument (the block row already names
  // its own member_id, 0034) — carried only so this action knows which
  // detail page to revalidate.
  const memberId = String(formData.get('memberId') ?? '');

  const token = await requireAccessToken();

  try {
    await liftMemberBlock(parsed.data, token);
    if (memberId) revalidatePath(`/members/${memberId}`);
    revalidatePath('/members');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, blockId: parsed.data.blockId }, 'lift member block failed');
    return { status: 'error', message: describeMembersWriteError(cause, 'lift this block') };
  }
}

// ---------------------------------------------------------------------------
// Erasure — members.erase. Irreversible; no undo action exists anywhere in
// this file because anonymize_member (0034) has no counterpart that restores
// what it scrubs.
// ---------------------------------------------------------------------------

export interface AnonymizeFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function anonymizeMemberAction(
  _prev: AnonymizeFormState,
  formData: FormData,
): Promise<AnonymizeFormState> {
  const parsed = anonymizeMemberSchema.safeParse({
    memberId: formData.get('memberId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Choose a reason.' };
  }

  const token = await requireAccessToken();

  try {
    await anonymizeMember(parsed.data.memberId, parsed.data.reason, token);
    revalidatePath(`/members/${parsed.data.memberId}`);
    revalidatePath('/members');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, memberId: parsed.data.memberId }, 'anonymize member failed');
    return {
      status: 'error',
      message: describeMembersWriteError(cause, "erase this listener's personal data"),
    };
  }
}
