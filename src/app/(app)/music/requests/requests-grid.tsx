'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SongThumb } from '@/components/music/song-thumb';
import type { ReferenceSummary, RequestSummary } from '@/services/music';
import { formatInstant } from '../../promotions/format';
import { AttendDialog } from './attend-dialog';
import { maskedPhone, PlayStatusBadge, ReadStatusBadge } from './request-status';
import { RecordRequestForm } from './record-request-form';

/** Nine: the six that existed, the two statuses, and Attend — which every caller sees (design D10). */
const COLUMN_COUNT = 9;

// The shared `vocab` keys, not a second wording: this column and the
// participations grid answer the same question about the same channels.
//
// API arrived with Block 15 and is NOT shared with participations, which has no
// such source: it means a third-party application posted the request over HTTP
// to /api/v1/music-requests. The type checker is what surfaced its absence here
// the moment 0151 added the value -- without this entry an API-sourced request
// would render a blank cell in the one column that explains where it came from.
//
// WEB arrived with Block 17b and the type checker did it again, which is the
// argument for this Record being exhaustive rather than a lookup with a
// fallback. It is not API: nobody authenticated with a credential and no
// application posted anything. A listener standing on the Station's own website
// pressed a button in the embedded widget.
const CHANNEL_LABEL_KEYS: Record<RequestSummary['channel'], string> = {
  MANUAL: 'sourceManual',
  IMPORT: 'sourceImport',
  API: 'sourceApi',
  WEB: 'sourceWeb',
};

/**
 * The requests list, and the host for the manual-entry dialog and the
 * withdraw confirmation over it — the same shape SongsGrid and MembersGrid
 * both use for their own screens.
 *
 * Neither write here patches a row locally: unlike Songs and Members,
 * actions.ts calls revalidatePath after each one (that file's own comment
 * says why — there is no getRequestById to re-read a single row from), so a
 * fresh page from the server is what updates this grid. `rows`/`total` are
 * plain props rather than local state for exactly that reason — the same
 * shape ParticipationsGrid already has for a screen whose own writes live
 * elsewhere.
 */
export function RequestsGrid({
  rows,
  total,
  covers,
  previousHref,
  nextHref,
  companyId,
  timeZone,
  shows,
  canRequest,
  canFindListeners,
  canRegisterListeners,
  canAttend,
  bounded,
}: {
  rows: RequestSummary[];
  /**
   * Cover hash by song id (Block 13a). A map rather than a field on the row
   * because these rows come from list_music_requests (0107), whose returned
   * columns carry no cover — widening that function would have meant DROP +
   * CREATE on a long RPC to add one field. services/music.ts's coversForSongs
   * fetches them for the page in one query instead.
   */
  covers: Map<string, string | null>;
  total: number;
  previousHref: string | null;
  nextHref: string | null;
  companyId: string;
  timeZone: string;
  shows: ReferenceSummary[];
  /** music.request — a courtesy gate; create_music_request and archive_music_request both re-check it themselves before writing anything. */
  canRequest: boolean;
  /** members.view, passed through to the manual form's listener picker. */
  canFindListeners: boolean;
  /** members.create, passed through to the manual form's registration half. */
  canRegisterListeners: boolean;
  /** participations.view — the owner's choice of gate (design D5). A courtesy gate; all four doors re-check it themselves. */
  canAttend: boolean;
  /**
   * Whether this read was a bounded batch rather than a page. Passed down
   * rather than derived from previousHref/nextHref: both are also null on an
   * ordinary single-page keyset result, so the cursors alone cannot tell a
   * batch apart from a page that simply has no more rows — only page.tsx,
   * which knows the sort and limit that produced this read, can say which.
   */
  bounded: boolean;
}) {
  const t = useTranslations('music');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const [recording, setRecording] = useState(false);
  // Derived from the live `rows` prop by id, every render, rather than a
  // snapshot taken when the button was pressed: actions.ts calls
  // revalidatePath after each mark, so re-deriving is what lets the open window
  // show the new status with no callback threaded back up — the shape
  // references-grid.tsx already uses for its record dialog. A request that
  // falls off the page (a filter it no longer matches) closes the window, which
  // is the honest outcome: the row it was showing is not on this list any more.
  const [attendingId, setAttendingId] = useState<string | null>(null);
  const attending = rows.find((row) => row.requestId === attendingId) ?? null;

  // The id outlives the row unless something clears it: `attending` going null
  // unmounts the dialog WITHOUT its onClose ever firing, so attendingId still
  // names a request that is no longer on this page. Clearing a filter then
  // brings the row back, `attending` matches again on its own, and the window
  // the operator already finished with reopens unprompted. Found by the e2e
  // journey walking the real path; the closing above is deliberate (this
  // component's own comment says so), the resurrection was not — nothing
  // chose it, so this effect is the fix, not a second opinion on the first
  // comment.
  useEffect(() => {
    if (attendingId !== null && !rows.some((row) => row.requestId === attendingId)) {
      setAttendingId(null);
    }
  }, [rows, attendingId]);

  return (
    <>
      {canRequest && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setRecording(true)} data-testid="request-record">
            {t('recordARequest')}</Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('listener')}</TableHead>
              <TableHead>{t('song')}</TableHead>
              <TableHead>{t('artist')}</TableHead>
              <TableHead>{t('programme')}</TableHead>
              <TableHead>{t('channel')}</TableHead>
              {/* No sort control: list_music_requests orders newest first,
                  fixed, because that is the one ordering a keyset cursor can
                  walk — the identical reasoning ParticipationsGrid's own
                  header carries for its Entered column. */}
              <TableHead aria-sort="descending">{t('requested')}</TableHead>
              <TableHead>{t('readStatusColumn')}</TableHead>
              <TableHead>{t('playStatusColumn')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="py-8 text-center text-muted-foreground"
                >
                  {t('noRequestMatchesTheseFilters')}</TableCell>
              </TableRow>
            ) : (
              rows.map((request) => (
                <TableRow key={request.requestId} data-testid="request-row">
                  <TableCell>
                    {/*
                      A null memberName has two different causes, and this
                      title must not claim the wrong one — the same
                      ambiguity ParticipationsGrid's own comment states for
                      listenerName. 0107's list joins members with no
                      anonymized_at filter, so a null here means either: this
                      caller holds music.view but not members.view (0107's
                      RULE 2, which withholds the two columns and still lists
                      every row), or this caller DOES hold members.view and
                      the listener has since exercised LGPD erasure
                      (anonymize_member nulls full_name). canFindListeners is
                      exactly which of the two is true, so the title is gated
                      on it rather than guessing — telling a caller who holds
                      members.view that they lack it would be a lie.
                    */}
                    {request.memberName === null ? (
                      <span
                        className="text-muted-foreground"
                        title={
                          canFindListeners
                            ? t('thisListenerHasSinceExercisedTheir')
                            : t('withheldYouDoNotHoldMembersView')
                        }
                        data-testid="request-listener-withheld"
                      >
                        —
                      </span>
                    ) : (
                      <>
                        <span className="text-sm">{request.memberName}</span>
                        {request.memberPhoneLast4 && (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {maskedPhone(request.memberPhoneLast4)}
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <SongThumb coverMd5={covers.get(request.songId) ?? null} />
                      <span className={request.songArchived ? 'text-muted-foreground' : undefined}>
                        {request.songTitle}
                      </span>
                    </span>
                    {/*
                      archive_song is deliberately never refused over a live
                      request naming it (0101's own comment) — a request is a
                      historical fact that outlives the song — so this row
                      stays legible with a muted badge rather than implying
                      the song is still in the catalogue.
                    */}
                    {request.songArchived && (
                      <span
                        className="ml-2 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        title={t('thisSongHasSinceBeenArchived')}
                        data-testid="request-song-archived-badge"
                      >
                        {t('archived')}</span>
                    )}
                    {/*
                      Block 17b. Under the title rather than in a column of its
                      own: it is empty for every request that did not come
                      through the widget, and a mostly-empty column costs every
                      row width to serve a few. Clamped to two lines with the
                      whole text in `title`, because a listener has 500
                      characters and a presenter reading between songs has a
                      glance.
                    */}
                    {request.listenerNote && (
                      <p
                        className="mt-1 line-clamp-2 text-xs text-muted-foreground"
                        title={request.listenerNote}
                        data-testid="request-listener-note"
                      >
                        {request.listenerNote}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{request.artistName}</TableCell>
                  <TableCell className="text-sm">{request.showName ?? '—'}</TableCell>
                  <TableCell className="text-sm">{tv(CHANNEL_LABEL_KEYS[request.channel])}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatInstant(request.requestedAt, timeZone)}
                  </TableCell>
                  <TableCell><ReadStatusBadge status={request.readStatus} /></TableCell>
                  <TableCell><PlayStatusBadge status={request.playStatus} /></TableCell>
                  <TableCell className="sticky right-0 bg-background text-right">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setAttendingId(request.requestId)}
                      aria-label={t('attendRequestFor', { title: request.songTitle })}
                      data-testid="request-attend"
                    >
                      {t('attend')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          // PageControls renders `${total} ${label}` whenever total is a
          // number (table.tsx) — fine for requestsLabel, a bare plural noun,
          // but showingOfTotal is a whole sentence that already carries both
          // numbers itself. Sending total through the numeric branch too
          // would print the count twice: "150 Showing 10 of 150". null routes
          // a bounded read through the else-branch, which renders the label
          // alone.
          total={bounded ? null : total}
          label={
            bounded
              ? t('showingOfTotal', { shown: rows.length, total })
              : t('requestsLabel', { count: total })
          }
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      {canRequest && (
        <RecordDialog
          open={recording}
          companyId={companyId}
          timeZone={timeZone}
          shows={shows}
          canFindListeners={canFindListeners}
          canRegisterListeners={canRegisterListeners}
          onClose={() => setRecording(false)}
        />
      )}

      {attending && (
        <AttendDialog
          request={attending}
          timeZone={timeZone}
          canAttend={canAttend}
          canFindListeners={canFindListeners}
          onClose={() => setAttendingId(null)}
        />
      )}
    </>
  );
}

function RecordDialog({
  open,
  companyId,
  timeZone,
  shows,
  canFindListeners,
  canRegisterListeners,
  onClose,
}: {
  open: boolean;
  companyId: string;
  timeZone: string;
  shows: ReferenceSummary[];
  canFindListeners: boolean;
  canRegisterListeners: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('recordARequest')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <RecordRequestForm
          companyId={companyId}
          timeZone={timeZone}
          shows={shows}
          canFindListeners={canFindListeners}
          canRegisterListeners={canRegisterListeners}
          onCancel={onClose}
        />
      </DialogBody>
    </Dialog>
  );
}
