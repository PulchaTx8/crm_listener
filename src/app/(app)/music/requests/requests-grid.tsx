'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ReferenceSummary, RequestSummary } from '@/services/music';
import { formatInstant } from '../../promotions/format';
import { archiveRequestAction, type ArchiveRequestState } from './actions';
import { RecordRequestForm } from './record-request-form';

/** The six columns every caller sees, before the Actions column that only canRequest adds. */
const BASE_COLUMN_COUNT = 6;

const INITIAL_ARCHIVE: ArchiveRequestState = { ok: null };

// The shared `vocab` keys, not a second wording: this column and the
// participations grid answer the same question about the same two channels.
const CHANNEL_LABEL_KEYS: Record<RequestSummary['channel'], string> = {
  MANUAL: 'sourceManual',
  IMPORT: 'sourceImport',
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
  previousHref,
  nextHref,
  companyId,
  timeZone,
  shows,
  canRequest,
  canFindListeners,
  canRegisterListeners,
}: {
  rows: RequestSummary[];
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
}) {
  const t = useTranslations('music');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const [recording, setRecording] = useState(false);
  const [archiving, setArchiving] = useState<RequestSummary | null>(null);

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
              {canRequest && (
                <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canRequest ? BASE_COLUMN_COUNT + 1 : BASE_COLUMN_COUNT}
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
                        {request.memberPhone && (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {request.memberPhone}
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={request.songArchived ? 'text-muted-foreground' : undefined}>
                      {request.songTitle}
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
                  </TableCell>
                  <TableCell className="text-sm">{request.artistName}</TableCell>
                  <TableCell className="text-sm">{request.showName ?? '—'}</TableCell>
                  <TableCell className="text-sm">{tv(CHANNEL_LABEL_KEYS[request.channel])}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatInstant(request.requestedAt, timeZone)}
                  </TableCell>
                  {canRequest && (
                    <TableCell className="sticky right-0 bg-background text-right">
                      <DropdownMenu
                        label={t('actionsForRequest', { title: request.songTitle })}
                        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                      >
                        <DropdownMenuItem destructive onSelect={() => setArchiving(request)}>
                          {t('withdrawRequest')}</DropdownMenuItem>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          total={total}
          label={t('requestsLabel', { count: total ?? 0 })}
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

      {archiving && (
        <ArchiveDialog
          request={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={() => setArchiving(null)}
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

/**
 * The confirmation names what withdrawing actually does — D5's own line
 * (0107's comment on archive_music_request): deleted_at exists on this table
 * only so a mistyped manual entry can be taken back, not to erase the fact
 * that a song was asked for.
 */
function ArchiveDialog({
  request,
  onCancel,
  onArchived,
}: {
  request: RequestSummary;
  onCancel: () => void;
  onArchived: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveRequestAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.ok === true) onArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('withdrawThisRequest')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {t('theRequestFor')}{request.songTitle}” leaves this list. This is for a mistyped entry —
          it does not undo the song being asked for, only the record of somebody having typed it
          in by mistake.
        </p>
        {state.ok === false && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <form action={action}>
          <input type="hidden" name="requestId" value={request.requestId} />
          <Button type="submit" disabled={pending} data-testid="request-archive-confirm">
            {pending ? t('withdrawing') : t('withdraw')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
