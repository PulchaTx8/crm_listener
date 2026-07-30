'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  getMember,
  listMemberBlocks,
  listMemberConsents,
  listMemberNotes,
  listMemberStations,
} from '@/services/members';
import type {
  MemberBlockRow,
  MemberConsentRow,
  MemberDetail,
  MemberNoteRow,
  MemberStationRow,
} from '@/services/members';
import { describeMembersReadError } from './errors';

export interface MemberRecord {
  detail: MemberDetail;
  stations: MemberStationRow[];
  consents: MemberConsentRow[];
  notes: MemberNoteRow[];
  blocks: MemberBlockRow[];
}

/**
 * Three outcomes, and `not-found` deliberately covers two different facts:
 * the listener does not exist, and the listener exists but is linked only to
 * Stations this caller cannot reach. RLS decides which rows exist; this action
 * must not let the screen tell those apart, or `?record=<id>` becomes an oracle
 * for ids — the same reasoning the retired detail page carried for its own
 * NotFound, and the reason its end-to-end test is rewritten rather than dropped.
 */
export type MemberRecordResult =
  | { status: 'ok'; record: MemberRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * One round trip for the whole record — identity, Stations, consents, notes
 * and blocks — rather than one per tab. The tabs render from what arrives, so
 * moving between them costs nothing and, more to the point, cannot re-run the
 * list query behind the dialog.
 *
 * Never throws to the client: the dialog renders a failure in its own body
 * while the list behind it stays usable, which is the whole advantage of the
 * record being a dialog rather than a page.
 */
export async function getMemberRecordAction(memberId: string): Promise<MemberRecordResult> {
  const accessToken = await requireAccessToken();

  try {
    const detail = await getMember(memberId, accessToken);
    if (!detail) return { status: 'not-found' };

    // Skipped entirely when the listener itself did not come back: each of
    // these four reads is independently RLS-scoped to memberId, so none would
    // return anything for a caller who cannot reach the listener's own row —
    // and there is no reason to make four requests to learn what a fifth
    // already answered. Copied in reasoning, not by accident, from the detail
    // page this replaces.
    const [stations, consents, notes, blocks] = await Promise.all([
      listMemberStations(memberId, accessToken),
      listMemberConsents(memberId, accessToken),
      listMemberNotes(memberId, accessToken),
      listMemberBlocks(memberId, accessToken),
    ]);

    return { status: 'ok', record: { detail, stations, consents, notes, blocks } };
  } catch (cause) {
    logger.error({ err: cause, memberId }, 'could not load this listener record');
    return { status: 'error', message: describeMembersReadError(cause) };
  }
}
