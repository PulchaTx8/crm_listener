'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState, type FormEvent } from 'react';
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
import { fromZonedDay } from '../promotions/zone';
import { MOVEMENT_TYPE_LABEL_KEYS } from './format';
import { MOVEMENT_TYPES, movementTypeFilter } from './movements/list-params';
import { getPrizeMovementsAction, updatePrizeAction, type PrizeSaveState } from './actions';
import { getPrizeRecordAction, type PrizeRecord } from './record';
import { BalanceStats } from './balance-stats';
import { MovementHistory } from './movement-history';
import { EntriesTab } from './entries-tab';
import { ExitsTab } from './exits-tab';
import { ReservationsTab } from './reservations-tab';

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
  canLinkPromotion,
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
  /**
   * promotions.prizes (fix round 1) — not one of `powers`' five inventory
   * codes, so it travels as its own prop rather than widening that interface
   * to a permission outside the domain it names. Gates whether Reservas'
   * own Tipo list offers "Vincular promoção" at all (station-access.ts's
   * own comment on `canLinkPromotion` says why a courtesy hide, not a
   * disabled option, is the right call here).
   */
  canLinkPromotion: boolean;
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
              <ReservationsTab
                companyId={record.companyId}
                prizeId={record.prize.id}
                page={record.reservations}
                timeZone={timeZone}
                canReserve={powers.reserve}
                canLinkPromotion={canLinkPromotion}
                onRecorded={refreshAfterMovement}
              />
            )}

            {tab === 'movements' && (
              // Movimentação never gets a form of its own (design D8/D10):
              // this unfiltered history — every kind, newest first — IS the
              // finished tab. Task 8 adds De/Até and a type filter above it;
              // it does not add writing.
              <MovementsTabPanel
                companyId={record.companyId}
                prizeId={record.prize.id}
                page={record.movements}
                timeZone={timeZone}
              />
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
 * The frame Movimentação still uses: its own filtered history
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
 * truncation-notice-plus-history frame, and Task 7 gives Reservas the same
 * treatment in `reservations-tab.tsx` for its own Release action — so
 * `movements` (Movimentação, which never offers a write of its own, D8/D10)
 * is the only tab still rendered through this panel.
 *
 * Task 8 adds De/Até and a type filter (design D10), gated behind a
 * Consultar button rather than applying as the operator types — deliberately
 * unlike every other filter this codebase has (movements-filters.tsx's own
 * header comment on the standalone `/inventory/movements` screen states the
 * identical reasoning for its own copy of these same three controls): a
 * period is typed in two halves, and re-running the read after De alone,
 * before Até has even been touched, is a wasted round trip and a list that
 * visibly narrows twice under the operator's hands.
 *
 * Consultar calls `getPrizeMovementsAction` directly (actions.ts) for a fresh,
 * narrower `PrizeMovementsPage`, rather than filtering `page.movements`
 * client-side: `page` is already `PRIZE_MOVEMENTS_LIMIT`-capped and
 * unfiltered, so a client-side filter over it could never tell "nothing
 * matches" apart from "something matches, past the 500 already loaded" —
 * and it would leave the truncation notice above comparing the FILTERED
 * `shown.movements` against the UNFILTERED `page.totalCount`, two different
 * questions dressed as one number. Asking the server again keeps `totalCount`
 * what it has always been here — the count of the SAME filtered set the rows
 * came from — so the notice stays honest for whichever filter is active
 * without this component needing to know that.
 *
 * `filtered` is `null` until the first Consultar returns; `shown` falls back
 * to the unfiltered `page` prop until then, which is what keeps this tab
 * looking exactly as it did before Task 8 when nobody has touched the
 * filter. `page` changing identity — a write on Entradas/Saídas/Reservas
 * reloading the whole record — resets `filtered` (and the drafts) back to
 * that same starting point: a Consultar result is a read against one
 * snapshot of this prize's ledger, and letting it linger after the ledger
 * itself just changed would show a "filtered" view the operator never asked
 * for against data that is no longer what they saw when they asked.
 */
function MovementsTabPanel({
  companyId,
  prizeId,
  page,
  timeZone,
}: {
  companyId: string;
  prizeId: string;
  page: PrizeMovementsPage;
  timeZone: string;
}) {
  const t = useTranslations('inventory');
  const [draftType, setDraftType] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [filtered, setFiltered] = useState<PrizeMovementsPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftType('');
    setDraftFrom('');
    setDraftTo('');
    setFiltered(null);
    setError(null);
  }, [page]);

  async function handleConsult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await getPrizeMovementsAction(companyId, prizeId, {
      types: movementTypeFilter(draftType),
      from: fromZonedDay(draftFrom, timeZone, false),
      to: fromZonedDay(draftTo, timeZone, true),
    });
    setPending(false);
    if (result.status === 'ok') {
      setFiltered(result.page);
    } else {
      setError(result.message);
    }
  }

  const shown = filtered ?? page;

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={handleConsult}
        className="flex flex-wrap items-end gap-3"
        data-testid="movements-tab-filters"
      >
        <label className="flex w-52 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('type')}</span>
          <Select
            value={draftType}
            onChange={(event) => setDraftType(event.target.value)}
            data-testid="movement-tab-type-filter"
          >
            <option value="">{t('everyMovementType')}</option>
            {MOVEMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(MOVEMENT_TYPE_LABEL_KEYS[type])}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex w-40 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('periodFrom')}</span>
          <Input
            type="date"
            value={draftFrom}
            onChange={(event) => setDraftFrom(event.target.value)}
            aria-label={t('showMovementsRecordedOnOrAfter')}
            data-testid="movement-tab-from-filter"
          />
        </label>

        <label className="flex w-40 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('periodTo')}</span>
          <Input
            type="date"
            value={draftTo}
            onChange={(event) => setDraftTo(event.target.value)}
            aria-label={t('showMovementsRecordedOnOrBefore')}
            data-testid="movement-tab-to-filter"
          />
        </label>

        <Button type="submit" disabled={pending} data-testid="movements-tab-consult">
          {pending ? t('loading') : t('consult')}
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {shown.totalCount > shown.movements.length && (
        <p className="text-xs text-muted-foreground" data-testid="movements-truncated">
          {t('showingOfTotalMovements', { shown: shown.movements.length, total: shown.totalCount })}
        </p>
      )}
      <MovementHistory
        movements={shown.movements}
        timeZone={timeZone}
        // A filter that narrowed the read to nothing reads differently from
        // a prize that has never moved at all — noMovementMatchesTheseFilters
        // is the same key movements-grid.tsx already shows the standalone
        // screen's own empty state with, reused here rather than a second
        // wording of the identical fact.
        emptyMessage={filtered ? t('noMovementMatchesTheseFilters') : t('noMovementsOfThisKind')}
      />
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
