'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/input';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { situationOf } from '@/lib/promotion-situation';
import { PROMOTION_TABS, type PromotionTab } from '@/lib/record-params';
import type { PromotionDetail, PromotionSummary } from '@/services/promotions';
import {
  archivePromotionAction,
  cancelPromotionAction,
  type ArchivePromotionState,
  type CancelPromotionState,
} from './actions';
import {
  formatQuestionCount,
  formatWindow,
  SITUATION_CLASSES,
  SITUATION_LABELS,
} from './format';
import { promotionSortHref } from './list-params';
import type { PromotionListState } from './list-params';
import { PromotionRecordDialog } from './promotion-record-dialog';
import { RegisterPromotionForm } from './register-promotion-form';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 6;

const INITIAL_CANCEL: CancelPromotionState = { status: 'idle' };
const INITIAL_ARCHIVE: ArchivePromotionState = { status: 'idle' };

export interface PromotionGridPowers {
  create: boolean;
  edit: boolean;
  cancel: boolean;
  archive: boolean;
  /** Forwarded to the record's Prizes tab: linking moves stock, so it is its own code. */
  prizes: boolean;
  /** The five the record's fifth tab stands on — three participations codes and two the audience owns. */
  participationsView: boolean;
  participationsCreate: boolean;
  participationsImport: boolean;
  membersView: boolean;
  membersCreate: boolean;
}

/** The grid's own view of a record, so a patched row and a fresh one agree. */
function toSummary(record: PromotionDetail): PromotionSummary {
  return {
    id: record.id,
    name: record.name,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    cancelledAt: record.cancelledAt,
    whatsappEnabled: record.whatsappEnabled,
    hashtag: record.hashtag,
    siteIntegrationCode: record.siteIntegrationCode,
    thumbUrl: record.thumbUrl,
    questionCount: record.questions.length,
    // Counted off the record the dialog already holds, so a patched row and a
    // freshly listed one agree on this too. QUIZ is the only kind with a right
    // answer (0041), which is what Block 6c filters by.
    quizQuestionCount: record.questions.filter((q) => q.kind === 'QUIZ').length,
    deletedAt: record.deletedAt,
  };
}

export function PromotionsGrid({
  initialRows,
  initialTotal,
  state,
  timeZone,
  previousHref,
  nextHref,
  powers,
  initialRecord,
}: {
  initialRows: PromotionSummary[];
  initialTotal: number;
  state: PromotionListState;
  timeZone: string;
  previousHref: string | null;
  nextHref: string | null;
  powers: PromotionGridPowers;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('promotions');
  const [grid, setGrid] = useState<RowState<PromotionSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(PROMOTION_TABS, initialRecord);
  const [cancelling, setCancelling] = useState<PromotionSummary | null>(null);
  const [archiving, setArchiving] = useState<PromotionSummary | null>(null);
  const [creating, setCreating] = useState(false);
  /** The promotion whose record was opened because it had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  const nameSorted = state.sort === 'name';
  const startsSorted = state.sort === 'starts';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {powers.create && (
        <div className="mt-4 flex justify-end">
          <Button type="button" onClick={() => setCreating(true)} data-testid="promotion-create">
            {t('registerPromotion')}</Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={promotionSortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('promotion')}</SortLink>
              </TableHead>
              <TableHead aria-sort={ariaSort(startsSorted)}>
                <SortLink
                  href={promotionSortHref(state, 'starts')}
                  active={startsSorted}
                  direction={startsSorted ? state.direction : 'desc'}
                >
                  {t('window')}</SortLink>
              </TableHead>
              {/* No sort link, and that is deliberate: Situation is computed
                  from three columns, and a keyset cursor must compare exactly
                  the column it orders by. It filters instead. */}
              <TableHead>{t('situation')}</TableHead>
              <TableHead>{t('hashtag')}</TableHead>
              <TableHead>{t('quiz')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="py-8 text-center text-muted-foreground">
                  {t('noPromotionHereYet')}</TableCell>
              </TableRow>
            ) : (
              grid.rows.map((promotion) => {
                const situation = situationOf(promotion);
                return (
                  <TableRow key={promotion.id} data-testid="promotion-row">
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => open(promotion.id)}
                        className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {promotion.name}
                      </button>
                      {promotion.deletedAt && (
                        <span className="ml-2 text-xs text-muted-foreground">(archived)</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatWindow(promotion.startsAt, promotion.endsAt, timeZone)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${SITUATION_CLASSES[situation]}`}
                        data-testid="promotion-situation"
                      >
                        {SITUATION_LABELS[situation]}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{promotion.hashtag ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      {formatQuestionCount(promotion.questionCount, t)}
                    </TableCell>
                    <TableCell className="sticky right-0 bg-background">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          aria-label={t('editPromotion', { name: promotion.name })}
                          onClick={() => open(promotion.id, 'data')}
                          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                        {(powers.cancel || powers.archive) && (
                          <DropdownMenu
                            label={t('actionsForPromotion', { name: promotion.name })}
                            trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                          >
                            {powers.cancel && (
                              <DropdownMenuItem
                                destructive
                                onSelect={() => setCancelling(promotion)}
                              >
                                {t('cancelPromotion')}</DropdownMenuItem>
                            )}
                            {powers.archive && (
                              <DropdownMenuItem
                                destructive
                                onSelect={() => setArchiving(promotion)}
                              >
                                {t('archivePromotion')}</DropdownMenuItem>
                            )}
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PageControls
          total={grid.total}
          label={t('promotionsLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      {/* The dialog's powers are named one by one rather than spread from this
          grid's own: PromotionPowers carries codes the record has no use for,
          and a spread would hand it every future one as well. */}
      <PromotionRecordDialog
        recordId={recordId}
        tab={(tab as PromotionTab) ?? 'data'}
        // The Station this list is showing, so the dialog can refuse a record
        // that belongs to a different one — `timeZone` and every flag in
        // `powers` below are that Station's answers, and a record from
        // elsewhere would be rendered against all of them.
        companyId={state.companyId}
        timeZone={timeZone}
        powers={{
          edit: powers.edit,
          prizes: powers.prizes,
          participationsView: powers.participationsView,
          participationsCreate: powers.participationsCreate,
          participationsImport: powers.participationsImport,
          membersView: powers.membersView,
          membersCreate: powers.membersCreate,
        }}
        onTab={setTab}
        onClose={close}
        onSaved={() => {
          /* The row is patched from the record's own re-read, in onLoaded. */
        }}
        onLoaded={(record) => {
          const row = toSummary(record);
          if (pendingCreate.current === record.id) {
            // A promotion registered a moment ago: its record was opened on the
            // id the create returned, and the row comes from that read. One
            // read rather than two — the second one was a defect Block 3c
            // found and fixed on the audience screen.
            pendingCreate.current = null;
            setGrid((current) => applyRowPatch(current, { kind: 'create', row }));
            return;
          }
          setGrid((current) => applyRowPatch(current, { kind: 'save', row }));
        }}
      />

      {cancelling && (
        <CancelPromotionDialog
          promotion={cancelling}
          onDismiss={() => setCancelling(null)}
          onCancelled={() => {
            const id = cancelling.id;
            setCancelling(null);
            setGrid((current) =>
              applyRowPatch(current, {
                kind: 'save',
                row: { ...cancelling, cancelledAt: new Date().toISOString() },
              }),
            );
            // Reopening the record is how the operator sees the reason they
            // just wrote, without the list being re-queried to show it.
            open(id);
          }}
        />
      )}

      {archiving && (
        <ArchivePromotionDialog
          promotion={archiving}
          onDismiss={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      <RegisterPromotionForm
        open={creating}
        companyId={state.companyId}
        timeZone={timeZone}
        onClose={() => setCreating(false)}
        onCreated={(promotionId) => {
          setCreating(false);
          pendingCreate.current = promotionId;
          open(promotionId);
        }}
      />
    </>
  );
}

function CancelPromotionDialog({
  promotion,
  onDismiss,
  onCancelled,
}: {
  promotion: PromotionSummary;
  onDismiss: () => void;
  onCancelled: () => void;
}) {
  const t = useTranslations('promotions');
  const titleId = useId();
  const [state, action, pending] = useActionState(cancelPromotionAction, INITIAL_CANCEL);

  useEffect(() => {
    if (state.status === 'cancelled') onCancelled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onDismiss} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('cancelThisPromotion')}</DialogTitle>
      </DialogHeader>
      <form action={action}>
        <DialogBody>
          <p className="text-sm">
            {promotion.name} {t('stopsAcceptingEntriesStraightAwayBefore')}</p>
          <input type="hidden" name="promotionId" value={promotion.id} />
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('whyIsItBeingCancelled')}</span>
            <Textarea name="reason" rows={3} required data-testid="promotion-cancel-reason" />
          </label>
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive">{state.message}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            {t('keepItRunning')}</Button>
          <Button type="submit" disabled={pending} data-testid="promotion-cancel-confirm">
            {pending ? t('cancelling') : t('cancelPromotionAction')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Deliberately NOT the sentence the inventory and audience screens use.
 * Archiving a promotion is reversible in a way archiving a prize or a listener
 * is not: promotions_select_promotions_view (0044) admits the owner to archived
 * rows, so the record survives for him and carries the name of whoever archived
 * it. Saying "this cannot be undone" here would be false.
 */
function ArchivePromotionDialog({
  promotion,
  onDismiss,
  onArchived,
}: {
  promotion: PromotionSummary;
  onDismiss: () => void;
  onArchived: (id: string) => void;
}) {
  const t = useTranslations('promotions');
  const titleId = useId();
  const [state, action, pending] = useActionState(archivePromotionAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(promotion.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onDismiss} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisPromotion')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {promotion.name} {t('leavesThisListAndEverybodyElse')}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('aPromotionStillInsideItsWindow')}</p>
        {state.status === 'error' && (
          <p className="mt-3 text-sm text-destructive" data-testid="promotion-archive-error">
            {state.message}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDismiss}>
          {t('keepIt')}</Button>
        <form action={action}>
          <input type="hidden" name="promotionId" value={promotion.id} />
          <Button type="submit" disabled={pending} data-testid="promotion-archive-confirm">
            {pending ? t('archiving') : t('archiveAction')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
