'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATUS_CLASSES, STATUS_LABEL_KEYS } from '@/lib/participation-status';
import { maskedPhone } from '@/lib/members/mask';
import { ListenerCardDialog } from '@/components/members/listener-card-dialog';
import type { ParticipationSummary } from '@/services/participations';
// The Station-zone instant formatter comes from the promotions screen's module
// rather than being re-derived here, on that module's own rule: an operator in
// another state reading their own local time would see an entry land an hour
// away from where the Station recorded it (spec L2). It pins the zone
// explicitly, which is also what keeps this client component's server render and
// its hydrated DOM agreeing about the day.
import { formatInstant } from '../promotions/format';
import { SOURCE_LABEL_KEYS } from './list-params';
import { ParticipationDialog } from './participation-dialog';

/**
 * How many columns the empty-state row has to span. Eight since Block 24: the
 * six that existed, the promotion's picture at the front and View at the back.
 */
const COLUMN_COUNT = 8;

/**
 * The list itself. It holds no state today, and it is still a client component
 * rather than a Server Component, which is a trade worth stating rather than
 * leaving to be discovered.
 *
 * What it buys: Task 8 hangs the manual-entry dialog, the import dialog and the
 * row patch that follows either of them off exactly this component, as
 * PromotionsGrid and MembersGrid both do on their own screens — that patch is
 * `useState` over these rows, so the boundary has to be here. Placing it now
 * means Task 8 adds to this file instead of turning it inside out.
 *
 * What it costs: a table that could have been pure HTML ships as JavaScript for
 * one task. The alternative — render it on the server and move the boundary in
 * Task 8 — was rejected for that rewrite, not because the server version would
 * not work.
 */
export function ParticipationsGrid({
  rows,
  total,
  timeZone,
  promotionThumbs,
  canFindListeners,
  previousHref,
  nextHref,
}: {
  rows: ParticipationSummary[];
  total: number;
  timeZone: string;
  /**
   * The promotion's picture by promotion id (Block 24, item 6). A map rather
   * than a field on the row, because these rows come from `list_participations`
   * (0090), whose returned columns carry no thumbnail — widening that function
   * would have meant DROP + CREATE on a long RPC to add one field. `page.tsx`
   * fetches them for the page in one query instead, exactly as
   * `requests-grid.tsx`'s `covers` map does for song artwork.
   */
  promotionThumbs: Map<string, string | null>;
  /** members.view, resolved once by participations/page.tsx (./access.ts) rather than a second time here. */
  canFindListeners: boolean;
  previousHref: string | null;
  nextHref: string | null;
}) {
  const t = useTranslations('participations');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');

  // Derived from the live `rows` prop by id, every render, rather than a
  // snapshot taken when the button was pressed — the shape AttendDialog uses,
  // and what lets a re-read of this page reach an open window.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = rows.find((row) => row.id === viewingId) ?? null;

  // The id outlives the row unless something clears it: `viewing` going null
  // unmounts the dialog WITHOUT its onClose ever firing, so viewingId still
  // names an entry that is no longer on this page. Clearing a filter then brings
  // the row back, `viewing` matches again on its own, and the window the operator
  // already finished with reopens unprompted. requests-grid.tsx shipped exactly
  // that defect and fixed it with this effect; copied rather than rediscovered.
  useEffect(() => {
    if (viewingId !== null && !rows.some((row) => row.id === viewingId)) {
      setViewingId(null);
    }
  }, [rows, viewingId]);

  // The listener card's id, cleared on the same rule and for the same reason
  // as viewingId just above: a filter that hides this row and is then undone
  // must not reopen a window the operator already closed.
  const [listenerId, setListenerId] = useState<string | null>(null);

  useEffect(() => {
    if (listenerId !== null && !rows.some((row) => row.memberId === listenerId)) {
      setListenerId(null);
    }
  }, [rows, listenerId]);

  return (
    <div className="mt-4 rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {/* No sort links anywhere in this header, and that is deliberate:
                the list is ordered by when the person entered, newest first,
                fixed, because that is the one ordering participations_listing_idx
                (0052) serves and a keyset cursor must compare exactly the columns
                it orders by. `aria-sort` on the Entered column states that
                ordering to assistive technology even though no control changes
                it — the table IS sorted, it simply cannot be re-sorted. */}
            {/* Block 24, item 6. No visible label: the pictures are a column
                beside the promotion names they belong to, and a heading over
                them would be read aloud on every row for nothing — the same
                treatment shows-grid.tsx gives its own picture column. */}
            <TableHead className="w-12">
              <span className="sr-only">{t('promotionPicture')}</span>
            </TableHead>
            <TableHead>{t('listener')}</TableHead>
            <TableHead>{t('promotion')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            <TableHead>{t('source')}</TableHead>
            <TableHead aria-sort="descending">{t('entered')}</TableHead>
            {/* Block 6c. Somebody who has already won here is not in the next
                round's hat (0076), so their row vanishes between rounds. This
                column is what turns that into something an operator can see
                coming rather than something they notice afterwards. */}
            <TableHead>{t('wonHere')}</TableHead>
            <TableHead className="sticky right-0 bg-background text-right">
              {t('actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="py-8 text-center text-muted-foreground">
                {/* Worded as a filter result rather than as "nothing here yet",
                    because there is always at least one filter on: the status
                    defaults to the entries that counted, and the note above this
                    table says so. */}
                {t('noEntryMatchesTheseFilters')}</TableCell>
            </TableRow>
          ) : (
            rows.map((entry) => (
              <TableRow key={entry.id} data-testid="participation-row">
                <TableCell>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {promotionThumbs.get(entry.promotionId) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={promotionThumbs.get(entry.promotionId) ?? undefined}
                      alt=""
                      width={32}
                      height={32}
                      className="rounded"
                    />
                  ) : (
                    <span className="block size-8 rounded bg-muted" aria-hidden="true" />
                  )}
                </TableCell>
                <TableCell>
                  {/*
                    A missing name is rendered the same way whatever the reason,
                    and that uniformity is the point rather than an oversight.
                    listenerName is null for an anonymised listener (0034 scrubs
                    full_name) and for a caller who holds participations.view but
                    not members.view, and telling those two apart here would let
                    this column answer "has this person been erased?" for somebody
                    who may not read the person at all.
                  */}
                  <span className="text-sm">{entry.listenerName ?? '—'}</span>
                  {(entry.listenerPhoneLast4 || entry.listenerCpfLastDigits) && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[
                        entry.listenerPhoneLast4 ? maskedPhone(entry.listenerPhoneLast4) : null,
                        entry.listenerCpfLastDigits ? `···${entry.listenerCpfLastDigits}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{entry.promotionName ?? '—'}</TableCell>
                <TableCell>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[entry.status]}`}
                    data-testid="participation-status"
                  >
                    {tv(STATUS_LABEL_KEYS[entry.status])}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{tv(SOURCE_LABEL_KEYS[entry.source])}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatInstant(entry.participatedAt, timeZone)}
                </TableCell>
                <TableCell className="text-sm" data-testid="participation-already-won">
                  {entry.alreadyWon ? t('yes') : '—'}
                </TableCell>
                {/* Block 24, item 6. Offered to every caller who can read this
                    list, on AttendDialog's own reasoning (Block 22, D10): the
                    window's first purpose is a calmer, fuller view of one entry,
                    and there is nothing in it to gate — every field it shows came
                    off a row this caller already has, and the answers are read
                    through the same permission that produced the row. */}
                <TableCell className="sticky right-0 bg-background text-right">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setViewingId(entry.id)}
                    aria-label={t('viewTheEntryOf', {
                      name: entry.listenerName ?? t('thisListener'),
                    })}
                    data-testid="participation-view"
                  >
                    {t('view')}
                  </Button>
                  {canFindListeners && (
                    <Button
                      key="view-listener"
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setListenerId(entry.memberId)}
                      aria-label={t('openTheMember')}
                      data-testid="participation-view-listener"
                    >
                      {/* Block 31a, D8. Renamed; the button beside it, which
                          opens the ENTRY rather than the person, is untouched. */}
                      {t('member')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/*
        `total` is the count of rows matching the same filters, taken from the
        same query builder as the rows themselves. The page above it is
        PARTICIPATION_PAGE_SIZE rows and no more: the read asks for one extra and
        the service spends it on nextHref, so the row that says "there is more"
        is never also rendered as a result.
      */}
      <PageControls
        total={total}
        label={t('entriesLabel', { count: total ?? 0 })}
        previousHref={previousHref}
        nextHref={nextHref}
      />

      {viewing && (
        <ParticipationDialog
          entry={viewing}
          promotionThumbUrl={promotionThumbs.get(viewing.promotionId) ?? null}
          timeZone={timeZone}
          onClose={() => setViewingId(null)}
        />
      )}

      {listenerId && (
        <ListenerCardDialog memberId={listenerId} onClose={() => setListenerId(null)} />
      )}
    </div>
  );
}
