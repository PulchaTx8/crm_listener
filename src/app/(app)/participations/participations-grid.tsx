'use client';

import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATUS_CLASSES, STATUS_LABELS } from '@/lib/participation-status';
import type { ParticipationSummary } from '@/services/participations';
// The Station-zone instant formatter comes from the promotions screen's module
// rather than being re-derived here, on that module's own rule: an operator in
// another state reading their own local time would see an entry land an hour
// away from where the Station recorded it (spec L2). It pins the zone
// explicitly, which is also what keeps this client component's server render and
// its hydrated DOM agreeing about the day.
import { formatInstant } from '../promotions/format';
import { SOURCE_LABELS } from './list-params';

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 5;

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
  previousHref,
  nextHref,
}: {
  rows: ParticipationSummary[];
  total: number;
  timeZone: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
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
            <TableHead>Listener</TableHead>
            <TableHead>Promotion</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead aria-sort="descending">Entered</TableHead>
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
                No entry matches these filters.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((entry) => (
              <TableRow key={entry.id} data-testid="participation-row">
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
                  {(entry.listenerPhone || entry.listenerCpfLastDigits) && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[
                        entry.listenerPhone,
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
                    {STATUS_LABELS[entry.status]}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{SOURCE_LABELS[entry.source]}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatInstant(entry.participatedAt, timeZone)}
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
        label={total === 1 ? 'entry' : 'entries'}
        previousHref={previousHref}
        nextHref={nextHref}
      />
    </div>
  );
}
