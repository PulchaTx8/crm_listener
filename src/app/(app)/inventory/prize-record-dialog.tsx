'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { PrizeCategorySummary, PrizeSummary } from '@/services/inventory';
import { updatePrizeAction, type PrizeSaveState } from './actions';
import { getPrizeRecordAction, type PrizeRecord } from './record';
import { BalanceStats } from './balance-stats';
import { AdjustmentForm } from './adjustment-form';
import { ReleaseForm, ReserveForm } from './reservation-forms';
import { StockEntryForm } from './stock-entry-form';
import { StockExitForm } from './stock-exit-form';
import { formatBucket, formatDateTime, MOVEMENT_TYPE_LABELS } from './format';

export const PRIZE_TABS = ['data', 'movements'] as const;
export type PrizeTab = (typeof PRIZE_TABS)[number];

const TAB_LABELS: Record<PrizeTab, string> = { data: 'Prize data', movements: 'Stock movements' };

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
 * record and for the same reason: one read per opening, both tabs rendered
 * from it, so nothing here can re-run the list query behind the dialog.
 */
export function PrizeRecordDialog({
  recordId,
  tab,
  categories,
  powers,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: PrizeTab;
  categories: PrizeCategorySummary[];
  powers: PrizeRecordPowers;
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
        result.status === 'not-found'
          ? 'No such prize, or you do not have permission to see this one.'
          : result.message,
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
   * Re-reads this one prize after a movement recorded inside the dialog, so the
   * ledger and the balance above it show what was just written.
   *
   * The detail page these forms used to live on got that from
   * revalidatePath('/inventory/[prizeId]'); that route is gone (Task 10) and
   * the list route must never be revalidated (the rule this block rests on), so
   * the record refreshes itself — one server action for one id, with nothing
   * about the list behind the dialog re-rendered or re-queried.
   */
  function refreshAfterMovement() {
    movementPending.current = true;
    setReloadToken((token) => token + 1);
  }

  function requestClose() {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setDirty(false);
    onClose();
  }

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{record?.prize.name ?? (loading ? 'Loading…' : 'Prize')}</DialogTitle>
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close record"
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label="Record sections" className="flex gap-1 border-b px-5">
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
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>
      )}

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">Loading the record…</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              Try again
            </Button>
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
                    You do not hold inventory.catalogue at this Station, so this prize can be read
                    here but not edited.
                  </p>
                )}
              </div>
            )}

            {tab === 'movements' && (
              <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  {powers.entry && (
                    <StockEntryForm
                      companyId={record.companyId}
                      prizeId={record.prize.id}
                      onRecorded={refreshAfterMovement}
                    />
                  )}
                  {powers.exit && (
                    <StockExitForm
                      companyId={record.companyId}
                      prizeId={record.prize.id}
                      onRecorded={refreshAfterMovement}
                    />
                  )}
                  {powers.adjust && (
                    <AdjustmentForm
                      companyId={record.companyId}
                      prizeId={record.prize.id}
                      balance={record.prize.balance}
                      onRecorded={refreshAfterMovement}
                    />
                  )}
                  {powers.reserve && (
                    <>
                      <ReserveForm
                        companyId={record.companyId}
                        prizeId={record.prize.id}
                        onRecorded={refreshAfterMovement}
                      />
                      <ReleaseForm
                        companyId={record.companyId}
                        prizeId={record.prize.id}
                        onRecorded={refreshAfterMovement}
                      />
                    </>
                  )}
                </div>

                <ul className="flex flex-col gap-2 text-sm">
                  {record.movements.map((movement) => (
                    <li key={movement.id} data-testid="movement-row" className="rounded-md border p-3">
                      <span className="font-medium">{MOVEMENT_TYPE_LABELS[movement.movementType]}</span>
                      {' · '}
                      {/* Both ends of the transition, always — formatBucket
                          renders a null bucket as "outside the Station" (0026's
                          own column comment), which is the whole reason it
                          takes null at all. Skipping the null end, as this did
                          when the ledger moved into the dialog, left a stock
                          entry reading "50 · to Available" with nowhere named
                          for the stock to have come from. */}
                      {movement.quantity} unit(s), {formatBucket(movement.fromBucket)} →{' '}
                      {formatBucket(movement.toBucket)}
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(movement.createdAt)}
                        {movement.note ? ` — ${movement.note}` : ''}
                      </span>
                    </li>
                  ))}
                  {record.movements.length === 0 && (
                    <li className="text-sm text-muted-foreground">This prize has never moved.</li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
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

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <Input name="name" defaultValue={prize.name} required maxLength={120} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Category</span>
        <Select name="categoryId" defaultValue={prize.categoryId ?? ''}>
          <option value="">Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Internal code</span>
        <Input name="internalCode" defaultValue={prize.internalCode ?? ''} maxLength={40} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Description</span>
        <Textarea name="description" defaultValue={prize.description ?? ''} />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allowsReturnToStock" defaultChecked={prize.allowsReturnToStock} />
        Allows return to stock
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </form>
  );
}
