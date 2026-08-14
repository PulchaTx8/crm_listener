'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';
import type { PrizeCategorySummary, PrizeMovementsPage, PrizeSummary } from '@/services/inventory';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { PRIZE_TABS, type PrizeTab } from '@/lib/record-params';
import { updatePrizeAction, type PrizeSaveState } from './actions';
import { getPrizeRecordAction, type PrizeRecord } from './record';
import { BalanceStats } from './balance-stats';
import { MovementHistory } from './movement-history';
import { EntriesTab } from './entries-tab';
import { ExitsTab } from './exits-tab';

// Catalogue keys, not words: a module body has no request behind it.
//
// `movements` keeps the pre-existing `stockMovements` label ("Stock
// movements") rather than a new key: it is still what this tab shows —
// Movimentação, the one unified history (design D10) — only the four forms
// that used to sit above it (D8) are gone.
const TAB_LABEL_KEYS: Record<PrizeTab, string> = {
  data: 'prizeData',
  entries: 'stockEntries',
  exits: 'stockExits',
  reservations: 'stockReservations',
  movements: 'stockMovements',
};

export interface PrizeRecordPowers {
  catalogue: boolean;
  entry: boolean;
  exit: boolean;
  adjust: boolean;
  reserve: boolean;
}

const INITIAL_SAVE: PrizeSaveState = { status: 'idle' };

/**
 * One prize's whole record over the inventory list. Same shape as the audience
 * record and for the same reason: one read per opening, every tab rendered
 * from it, so nothing here can re-run the list query behind the dialog.
 */
export function PrizeRecordDialog({
  recordId,
  tab,
  categories,
  powers,
  timeZone,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: PrizeTab;
  categories: PrizeCategorySummary[];
  powers: PrizeRecordPowers;
  /** The Station's own zone (spec §7) — passed down to MovementHistory so a movement's date renders in the zone it actually happened in, not the reader's. */
  timeZone: string;
  onTab: (tab: PrizeTab) => void;
  onClose: () => void;
  onSaved: (prize: PrizeSummary) => void;
  /**
   * Every successful read of a record, which is how a prize registered a
   * moment ago gets its row: the grid opens the new record and takes the row
   * from this read rather than from a second one of its own.
   */
  onLoaded?: (prize: PrizeSummary) => void;
}) {
  const t = useTranslations('inventory');
  const titleId = useId();
  const [record, setRecord] = useState<PrizeRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Set when a movement was recorded, so that the balance the re-read brings
  // back is carried out to the grid's row as well as into this dialog. A ref
  // rather than state: it is a note to the next read, and making it state
  // would put it in that read's own dependency list, where changing it would
  // trigger the very read it is describing.
  const movementPending = useRef(false);

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setDirty(false);
      movementPending.current = false;
      return;
    }
    let current = true;
    setLoading(true);
    setFailure(null);
    void getPrizeRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        onLoaded?.(result.record.prize);
        if (movementPending.current) {
          movementPending.current = false;
          // A movement changes the balance, and the balance is on the grid's
          // row. Patched from what the record just read rather than computed
          // here: reconciling buckets is the database's arithmetic, not this
          // component's.
          onSaved(result.record.prize);
        }
        return;
      }
      setRecord(null);
      setFailure(
        result.status === 'not-found' ? t('noSuchPrizeOrYouDo') : result.message,
      );
    });
    return () => {
      current = false;
    };
    // onSaved is stable for this dialog's lifetime, and adding it would make
    // the record re-read whenever the grid re-renders its callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, reloadToken]);

  /**
   * Re-reads this one prize after a movement recorded or reversed inside the
   * dialog, so the ledger and the balance above it show what was just
   * written. Task 5's own comment on this file named the shape Tasks 6/7
   * would need — bump `reloadToken`, set `movementPending.current` — and this
   * is that: `onRecorded` on both EntriesTab and ExitsTab (Task 6) and, once
   * Task 7 lands, ReservasTab as well.
   *
   * The detail page these forms used to live on got the same effect from
   * `revalidatePath('/inventory/[prizeId]')`; that route is gone (Task 10)
   * and the list route must never be revalidated (the rule this block rests
   * on), so the record refreshes itself — one server action for one id, with
   * nothing about the list behind the dialog re-rendered or re-queried.
   */
  function refreshAfterMovement() {
    movementPending.current = true;
    setReloadToken((token) => token + 1);
  }

  function requestClose() {
    if (dirty && !window.confirm(t('discardTheChangesYouHaveNotSaved'))) return;
    setDirty(false);
    onClose();
  }

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{record?.prize.name ?? (loading ? t('loading') : t('prize'))}</DialogTitle>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
          {PRIZE_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => onTab(name)}
              className={
                tab === name
                  ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
            >
              {t(TAB_LABEL_KEYS[name])}
            </button>
          ))}
        </div>
      )}

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">{t('loadingTheRecord')}</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              {t('tryAgain')}</Button>
          </div>
        )}

        {record && (
          <>
            {tab === 'data' && (
              <div className="flex flex-col gap-6">
                <BalanceStats balance={record.prize.balance} />
                {powers.catalogue ? (
                  <PrizeDataForm
                    prize={record.prize}
                    categories={categories}
                    onDirty={setDirty}
                    onSaved={(saved) => {
                      setDirty(false);
                      setRecord({ ...record, prize: saved });
                      onSaved(saved);
                    }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('youDoNotHoldInventoryCatalogue')}</p>
                )}
              </div>
            )}

            {tab === 'entries' && (
              <EntriesTab
                companyId={record.companyId}
                prizeId={record.prize.id}
                balance={record.prize.balance}
                page={record.entries}
                timeZone={timeZone}
                canEnter={powers.entry}
                canAdjust={powers.adjust}
                onRecorded={refreshAfterMovement}
              />
            )}

            {tab === 'exits' && (
              <ExitsTab
                companyId={record.companyId}
                prizeId={record.prize.id}
                balance={record.prize.balance}
                page={record.exits}
                timeZone={timeZone}
                canExit={powers.exit}
                canAdjust={powers.adjust}
                onRecorded={refreshAfterMovement}
              />
            )}

            {tab === 'reservations' && (
              // Task 7 adds the Reservas form (Tipo: Reservar / Vincular
              // Programa / Vincular Promoção) above this history.
              <MovementsTabPanel page={record.reservations} timeZone={timeZone} />
            )}

            {tab === 'movements' && (
              // Movimentação never gets a form of its own (design D8/D10):
              // this unfiltered history — every kind, newest first — IS the
              // finished tab. Task 8 adds De/Até and a type filter above it;
              // it does not add writing.
              <MovementsTabPanel page={record.movements} timeZone={timeZone} />
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The frame Reservas and Movimentação still share: their own filtered history
 * (`MovementHistory`), with a notice above it when `list_movements`' own cap
 * (`PRIZE_MOVEMENTS_LIMIT`, 500 per call) has truncated what that tab's own
 * read returned.
 *
 * `totalCount` is the count of the FILTERED set, from the same read the rows
 * came from (services/inventory.ts's own comment on `PrizeMovementsPage`) —
 * comparing it against the rows actually on hand is what tells a cut history
 * apart from a complete one, rather than letting the list simply end with no
 * word on whether that was everything.
 *
 * Kept in this file rather than folded into `MovementHistory` itself:
 * `MovementHistory`'s four props are the exact shape Task 5's own "Produces"
 * line commits Tasks 6–8 to calling it with, and a fifth prop here would be a
 * signature none of them asked for. `onReverse` is not wired here — Task 6
 * offers archiving on Entradas/Saídas through their own tab components
 * (`entries-tab.tsx`/`exits-tab.tsx`), each with its own copy of this same
 * truncation-notice-plus-history frame rather than a shared prop on this
 * function, so the 'reservations' and 'movements' tabs below are the only
 * two still rendered through this panel, and neither offers archiving yet.
 */
function MovementsTabPanel({ page, timeZone }: { page: PrizeMovementsPage; timeZone: string }) {
  const t = useTranslations('inventory');
  return (
    <div className="flex flex-col gap-3">
      {page.totalCount > page.movements.length && (
        <p className="text-xs text-muted-foreground" data-testid="movements-truncated">
          {t('showingOfTotalMovements', { shown: page.movements.length, total: page.totalCount })}
        </p>
      )}
      <MovementHistory movements={page.movements} timeZone={timeZone} emptyMessage={t('noMovementsOfThisKind')} />
    </div>
  );
}

/**
 * Every field on every save: update_prize (0027) sets each column it takes on
 * every call, so a partial submission blanks whatever it leaves out.
 */
function PrizeDataForm({
  prize,
  categories,
  onDirty,
  onSaved,
}: {
  prize: PrizeSummary;
  categories: PrizeCategorySummary[];
  onDirty: (dirty: boolean) => void;
  onSaved: (prize: PrizeSummary) => void;
}) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(updatePrizeAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved' && state.prize) onSaved(state.prize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      onChange={() => onDirty(true)}
      data-testid="prize-data-form"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="prizeId" value={prize.id} />

      <ImageUploadField
        name="photo"
        kind="thumb"
        currentUrl={prize.photoUrl}
        disabled={pending}
        onDirty={() => onDirty(true)}
        label={t('prizePicture')}
        hint={t('shownOnTheStockList')}
      />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input name="name" defaultValue={prize.name} required maxLength={120} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('category')}</span>
        <Select name="categoryId" defaultValue={prize.categoryId ?? ''}>
          <option value="">{t('uncategorised')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('internalCode')}</span>
        <Input name="internalCode" defaultValue={prize.internalCode ?? ''} maxLength={40} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('description')}</span>
        <Textarea name="description" defaultValue={prize.description ?? ''} />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allowsReturnToStock" defaultChecked={prize.allowsReturnToStock} />
        {t('allowsReturnToStock')}</label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
      </div>
    </form>
  );
}
