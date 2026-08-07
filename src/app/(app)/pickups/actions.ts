'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { cancelDelivery, deliverPrize, returnPrize, writeOffPrize } from '@/services/winners';
import { reopenPickupDeadline } from '@/services/pickups';
import type { WinnerStatus } from '@/services/pickups';
import type { WinnerAction } from '@/components/draws/winner-actions';
import { describePickupsWriteError } from './errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately — the same standing rule
// participations/actions.ts, promotions/actions.ts, members/actions.ts and
// inventory/actions.ts all carry, restated here because it binds especially
// hard on this screen: /pickups is one keyset page over every winner of a
// Station, soonest deadline first, and revalidatePath would re-run that
// query underneath an operator who is midway down the list acting on rows —
// silently, because the screen would still look right. Every action below
// returns the row's new status (and, for reopen, its new deadline) instead,
// and pickups-grid.tsx patches its own row with it. The row can end up
// showing under a status filter it technically no longer matches — the
// runbook calls this "one refresh behind" and the alternative is worse: an
// operator loses their place in the list every time they act on a row in it.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type PickupActionResult =
  | { status: 'ok'; winnerStatus: WinnerStatus; deadlineAt?: string }
  | { status: 'error'; message: string };

/**
 * The four transitions WinnerActions' generic reason-only confirm row can
 * actually finish. `action` is the full `WinnerAction` type — the same
 * reasoning draws/actions.ts's own winnerActionAction gives for accepting it
 * unnarrowed — because that is what WinnerActions' `onAct` hands up, and
 * narrowing the parameter here only moves the type error to the caller.
 *
 * 'reopen' falls to the else branch and is refused with a fixed sentence,
 * same shape draws/actions.ts uses for the identical reason: reopening needs
 * a NEW deadline, which this generic one-Input confirm row has no field for.
 * It is unreachable through this action's own button on THIS screen —
 * pickups-grid.tsx passes WinnerActions a `reopenDeadline: false` powers
 * object so the generic "Reopen the deadline" button never renders here —
 * but the branch still exists because the compiler cannot see that.
 * reopen-form.tsx calls reopenPickupAction below instead, which does have the
 * field.
 */
export async function pickupWinnerAction(
  winnerId: string,
  action: WinnerAction,
  reason: string,
): Promise<PickupActionResult> {
  const token = await requireAccessToken();
  try {
    let winnerStatus: WinnerStatus;
    if (action === 'deliver') {
      await deliverPrize(token, { winnerId, note: reason.trim() || null });
      winnerStatus = 'DELIVERED';
    } else if (action === 'cancel_delivery') {
      await cancelDelivery(token, { winnerId, reason });
      winnerStatus = 'AWAITING_PICKUP';
    } else if (action === 'return') {
      await returnPrize(token, { winnerId, reason });
      winnerStatus = 'RETURNED';
    } else if (action === 'write_off') {
      await writeOffPrize(token, { winnerId, reason });
      winnerStatus = 'WRITTEN_OFF';
    } else {
      return {
        status: 'error',
        message: (await getTranslations('pickups'))('reopeningNeedsTheFormBelow'),
      };
    }
    return { status: 'ok', winnerStatus };
  } catch (cause) {
    logger.error({ err: cause, winnerId, action }, 'winner transition failed on the pickups screen');
    return { status: 'error', message: describePickupsWriteError(cause, await getTranslations('pickups'), 'actionChangeThisPrize') };
  }
}

/**
 * The one action this screen exists to offer that no other screen can:
 * reopen_pickup_deadline (0093) needs a new deadline as well as a reason.
 * Called from reopen-form.tsx, never from WinnerActions' own generic button.
 */
export async function reopenPickupAction(
  winnerId: string,
  deadlineAt: string,
  reason: string,
): Promise<PickupActionResult> {
  const token = await requireAccessToken();
  try {
    await reopenPickupDeadline(token, { winnerId, deadlineAt, reason });
    return { status: 'ok', winnerStatus: 'AWAITING_PICKUP', deadlineAt };
  } catch (cause) {
    logger.error({ err: cause, winnerId }, 'reopen_pickup_deadline failed');
    return { status: 'error', message: describePickupsWriteError(cause, await getTranslations('pickups'), 'actionReopenThisDeadline') };
  }
}
