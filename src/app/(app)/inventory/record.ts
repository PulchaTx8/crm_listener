'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { getPrizeById, getPrizeMovements } from '@/services/inventory';
import type { PrizeMovementsPage, PrizeSummary } from '@/services/inventory';
import { listLinkablePromotions } from '@/services/promotions';
import type { LinkablePromotion } from '@/services/promotions';
import { listReservableShows } from '@/services/shows';
import type { ReservableShow } from '@/services/shows';
import { listVendorOptions } from '@/services/vendors';
import type { VendorOption } from '@/services/vendors';
import { ENTRY_MOVEMENT_TYPES, EXIT_MOVEMENT_TYPES, RESERVATION_MOVEMENT_TYPES } from './format';
import { describeInventoryReadError } from './errors';

export interface PrizeRecord {
  companyId: string;
  prize: PrizeSummary;
  /**
   * One page per tab (Block 23, Task 5), each `getPrizeMovements` call
   * narrowed to its own group of kinds (format.ts's three arrays) except
   * `movements`, called with `types` omitted — the Movimentação tab is the
   * one unified view (design D10) and passing an empty array there would
   * ask `list_movements` for the empty set instead (0196's own comment: an
   * empty `p_types` array matches nothing, `null` means no filter).
   */
  entries: PrizeMovementsPage;
  exits: PrizeMovementsPage;
  reservations: PrizeMovementsPage;
  movements: PrizeMovementsPage;
  /**
   * Reservas' own programme/promotion pickers (Task 7), read here rather
   * than lazily from `ReservationsTab` itself — moved here in a Task 9
   * follow-up, and the reason is load-bearing enough to state in full.
   *
   * MEASURED: with the pickers fetched from a `useEffect` inside
   * `reservations-tab.tsx`, calling the Server Action directly on mount,
   * React Strict Mode's dev-only double-invoke of that effect (mount →
   * cleanup → mount, timestamped within 1–2ms of each other, no yield to the
   * microtask queue in between) left the picker fetch permanently
   * unresolved roughly half the time: both invocations reached the action
   * and each received a Promise back, but neither ever settled, and neither
   * call reached the server at all.
   *
   * THE MECHANISM, as established by reading Next's own dispatcher rather
   * than assumed: `callServer` wraps each Server Action call in
   * `dispatchAppRouterAction`, whose `dispatchAction` runs the first action
   * immediately and *appends* a second to the queue for
   * `runRemainingActions` — two back-to-back calls are serialised, not
   * lost, on their own. What actually does the losing is `useRecordDialog`'s
   * own tab switch: `setTab` calls `window.history.replaceState(null, …)`
   * (`src/hooks/use-record-dialog.ts:89`), and a `null` state object carries
   * neither marker Next's router looks for, so every tab click is read as an
   * `ACTION_RESTORE`. That takes a priority branch that marks the pending
   * action discarded and never updates `actionQueue.last` — a Server Action
   * dispatched inside that window is appended to a queue node no longer
   * reachable from `pending`: never run, never sent, never settled. Six
   * other call sites in this codebase invoke a Server Action directly from
   * an effect the same way (`prize-record-dialog.tsx`, `member-record-dialog.tsx`,
   * `album-record-dialog.tsx`, `request-song.tsx` twice, `enter-promotion.tsx`)
   * and none of them hang, because none of them are dispatched from a tab
   * that has *just* been switched to — `acceptance.spec.ts`'s own journey
   * waits for "Stock added." (a local state flip) and then switches tabs
   * while the record's own re-read is still in flight, which is exactly the
   * window `replaceState` needs to land in.
   *
   * THE FIX is to remove the second dispatch rather than time around it:
   * this action already crosses the wire once when the record opens and
   * already reads four movement pages in one `Promise.all` (Task 5's own
   * shape for every other read on this dialog) — the two picker reads join
   * that same round trip, so Reservas never dispatches anything of its own
   * and there is no window left to land in.
   */
  shows: ReservableShow[];
  promotions: LinkablePromotion[];
  /**
   * Block 24, item 8. Entradas' own supplier picker, read HERE for exactly the
   * reason the comment above gives for the two pickers beside it — and not as a
   * weaker version of it: Entradas is a tab, reached by a tab click, which is
   * the precise window `useRecordDialog`'s `replaceState` turns into an
   * `ACTION_RESTORE` that discards a Server Action dispatched inside it. A
   * picker fetched from an effect in `stock-entry-form.tsx` would be the seventh
   * call site of a shape that has already hung once here.
   *
   * Read unconditionally, like `shows` and `promotions`: this action has never
   * known about permissions beyond `inventory.view` (the page's own gate), and
   * `EntriesTab`'s own render is what gates the form behind `canEnter`.
   */
  vendors: VendorOption[];
}

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the prize does
 * not exist, and the prize is at a Station this caller cannot reach. RLS
 * decides which rows exist (prizes_select_inventory_view, 0029) and this must
 * not let the screen tell them apart — the same reasoning the audience record
 * carries, and the same reason the retired prize page collapsed them too.
 */
export type PrizeRecordResult =
  | { status: 'ok'; record: PrizeRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * `getPrizeMovements` (Task 4) is SECURITY DEFINER and re-checks
 * `has_permission` against `auth.uid()` in its own body, so it needs the
 * caller's own JWT rather than the cookie session `getPrizeById` reads
 * through — the same plumbing `members/record.ts` and `promotions/record.ts`
 * already carry for their own RPC-backed reads.
 */
async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * One round trip for the whole record — the prize with its balances, all
 * four of the movement histories the tabs need, and (Task 9 follow-up)
 * Reservas' own programme/promotion pickers — rather than one read per tab
 * switch. This is the same shape `members/record.ts` already established
 * for its own five tabs (its own header states the reasoning at length): the
 * tabs render from what arrives, so switching between them costs nothing,
 * cannot re-run the list query behind the dialog, and — the reason the
 * pickers joined this call rather than staying a read of their own —
 * dispatches nothing of its own for a tab switch to ever race.
 *
 * It also keeps the four histories mutually consistent for free. A stock
 * entry recorded through the Entradas tab lands a row in Entradas AND in
 * Movimentação (the unfiltered view) and changes the balance `data` shows —
 * three places one write touches. Tasks 6/7's own reload after a write is
 * this whole action run again (prize-record-dialog.tsx's `reloadToken`, the
 * same mechanism the old two-tab dialog used), never a re-fetch of only the
 * tab that was open — so none of the other three can be left showing what
 * was true before the write.
 *
 * `shows`/`promotions` are read unconditionally, the same way `entries`/
 * `exits`/`reservations` already are for every caller regardless of which of
 * the five write permissions they hold — `ReservationsTab`'s own render is
 * still what gates the reservation form behind `canReserve`, exactly as
 * `powers.entry`/`powers.exit` already gate theirs; this action has never
 * known about permissions beyond `inventory.view` (the page's own gate) and
 * does not start now.
 *
 * All six reads run in `Promise.all` rather than in sequence: independent
 * queries with nothing for one to learn from another, the same reasoning
 * `members/record.ts` gives for its own four parallel reads.
 */
export async function getPrizeRecordAction(prizeId: string): Promise<PrizeRecordResult> {
  const accessToken = await requireAccessToken();

  try {
    const found = await getPrizeById(prizeId);
    if (!found) return { status: 'not-found' };

    const [entries, exits, reservations, movements, shows, promotions, vendors] = await Promise.all([
      getPrizeMovements(found.companyId, prizeId, accessToken, ENTRY_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken, EXIT_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken, RESERVATION_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken),
      listReservableShows(found.companyId),
      listLinkablePromotions(found.companyId),
      listVendorOptions(found.companyId),
    ]);

    return {
      status: 'ok',
      record: {
        companyId: found.companyId,
        prize: found.prize,
        entries,
        exits,
        reservations,
        movements,
        shows,
        promotions,
        vendors,
      },
    };
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'could not load this prize record');
    return { status: 'error', message: describeInventoryReadError(cause, await getTranslations('inventory')) };
  }
}
