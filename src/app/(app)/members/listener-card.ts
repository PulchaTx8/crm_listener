'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { createUserClient } from '@/lib/supabase/user-client';
import { getMember } from '@/services/members';
import { revealMemberField } from '@/services/members';
import {
  lastFourDigits,
  maskedAddress,
  maskedEmail,
  maskedPassport,
} from '@/lib/members/mask';

/**
 * Block 30a. One listener, as three screens that only read may see them.
 *
 * MASKED HERE, NOT IN THE COMPONENT, and that is the whole point of the file:
 * what this returns is what reaches the browser. A component that received the
 * whole record and rendered dots over it would put every value in the HTML
 * payload, which is the failure 0254 exists to close one layer down.
 *
 * THE READ ITSELF IS RLS. getMember goes through the caller's own client, so
 * members_select_reachable (0035) decides which listeners exist for them -- the
 * same boundary the three calling screens already rely on for their own lists.
 * No new read door was needed, and adding one would have moved a tenancy
 * boundary from a policy into a function body.
 */

export type RevealableField = 'phone' | 'email' | 'passport' | 'address';

const revealSchema = z.object({
  memberId: z.string().uuid(),
  field: z.enum(['phone', 'email', 'passport', 'address']),
});

/**
 * `requireAccessToken` (record.ts) is private to that file -- copied rather
 * than exported for this one other caller, which would widen a helper built
 * for a single screen.
 */
async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/** Everything the card shows. Nothing here is a whole sensitive value. */
export interface ListenerCard {
  id: string;
  fullName: string | null;
  phoneLast4: string | null;
  emailMasked: string | null;
  passportMasked: string | null;
  addressMasked: string | null;
  /** Already only the last digits in the column (0031) -- the CPF itself is a hash. */
  cpfLastDigits: string | null;
  birthDate: string | null;
  gender: string | null;
  city: string | null;
  state: string | null;
  neighbourhood: string | null;
  country: string | null;
  createdAt: string;
  anonymizedAt: string | null;
}

export type ListenerCardResult =
  | { status: 'ok'; card: ListenerCard }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function getListenerCardAction(memberId: string): Promise<ListenerCardResult> {
  const parsed = z.string().uuid().safeParse(memberId);
  if (!parsed.success) return { status: 'not-found' };

  try {
    const token = await requireAccessToken();
    const detail = await getMember(parsed.data, token);
    if (!detail) return { status: 'not-found' };

    return {
      status: 'ok',
      card: {
        id: detail.id,
        fullName: detail.fullName,
        phoneLast4: lastFourDigits(detail.phone),
        emailMasked: maskedEmail(detail.email),
        passportMasked: maskedPassport(detail.passport),
        addressMasked: maskedAddress({
          line: detail.addressLine,
          number: detail.addressNumber,
          complement: detail.addressComplement,
        }),
        cpfLastDigits: detail.cpfLastDigits,
        birthDate: detail.birthDate,
        gender: detail.gender,
        city: detail.city,
        state: detail.state,
        neighbourhood: detail.neighbourhood,
        country: detail.country,
        createdAt: detail.createdAt,
        anonymizedAt: detail.anonymizedAt,
      },
    };
  } catch (cause) {
    logger.error({ err: cause, memberId }, 'could not read this listener card');
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotReadThisListener') };
  }
}

export type RevealResult =
  | { status: 'ok'; value: string | null }
  | { status: 'error'; message: string };

export async function revealListenerFieldAction(
  memberId: string,
  field: RevealableField,
): Promise<RevealResult> {
  const parsed = revealSchema.safeParse({ memberId, field });
  if (!parsed.success) {
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotRevealThisField') };
  }

  try {
    const token = await requireAccessToken();
    return {
      status: 'ok',
      value: await revealMemberField(parsed.data.memberId, parsed.data.field, token),
    };
  } catch (cause) {
    // NEVER LOG THE FIELD'S VALUE, and note that this branch cannot: the
    // service throws before returning. The member id and the field NAME are
    // logged; the value is the thing the audit row exists to account for, and a
    // log file honours no retention rule.
    logger.error({ err: cause, memberId, field }, 'could not reveal a listener field');
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotRevealThisField') };
  }
}
