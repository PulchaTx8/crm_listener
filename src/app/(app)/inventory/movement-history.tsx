'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MovementEntry } from '@/services/inventory';
import { formatInstant } from '../promotions/format';
import { ENTRY_MOVEMENT_TYPES, EXIT_MOVEMENT_TYPES, formatBucket, MOVEMENT_TYPE_LABEL_KEYS } from './format';

export type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * `actorId` and `actorName` are both nullable, and the two nulls mean
 * different things (design D11; MovementEntry's own header on `actorName`
 * states the discipline this follows): `actorId === null` is an automated
 * write with no operator behind it at all — today, only the deadline sweep
 * (0092/0094) — never rendered as "unnamed", which would credit a machine
 * for something nobody did. `actorId` present with `actorName === null` is a
 * real person who simply has no display name on record
 * (`profiles.full_name` is nullable). Read `actorId` FIRST and branch on
 * that alone, the same discipline movements/list-params.ts's own
 * describeMovementActor keeps for the standalone screen — except this one
 * goes through `t` rather than a hard-coded English string, because this is
 * new code and "No user-facing sentence outside next-intl" applies to it.
 */
export function describeActor(movement: MovementEntry, t: Translator): string {
  if (movement.actorId === null) return t('movementActorDeadline');
  return movement.actorName ?? t('unnamedOperator');
}

/**
 * Whether this row offers an action through `onReverse`, and which catalogue
 * key labels it — driven entirely by the movement's OWN type and its own
 * reversal/remaining state, never by which tab happens to be rendering it.
 * A `PROMOTION_LINK` row reads the same way in Reservas and in Movimentação;
 * a `RESERVATION` already fully released offers nothing further in either.
 *
 * `null` covers three different reasons a row has no action, on purpose:
 * already reversed/fully released, a promotion link (undone on the
 * promotion's own screen — see the caller for that text), or a type this
 * door was never going to touch (a draw, a delivery, an adjustment, a
 * reversal that was itself reversed already). The caller does not need to
 * tell those apart; it only needs to know whether to render a button.
 */
export function actionLabelKey(movement: MovementEntry): string | null {
  if (movement.movementType === 'RESERVATION') {
    return movement.remainingQuantity !== null && movement.remainingQuantity > 0
      ? 'releaseThisReservation'
      : null;
  }
  if (movement.movementType === 'PROMOTION_LINK' || movement.movementType === 'PROMOTION_UNLINK') {
    return null;
  }
  if (
    movement.reversedAt === null &&
    (ENTRY_MOVEMENT_TYPES.includes(movement.movementType) || EXIT_MOVEMENT_TYPES.includes(movement.movementType))
  ) {
    return 'archiveMovement';
  }
  return null;
}

/**
 * `unit_amount`/`total_amount` carry no currency column (design §4) — a plain
 * figure, never a symbol this product does not know it is entitled to print.
 *
 * Grouped through next-intl's own formatter rather than a hard-coded
 * `Intl.NumberFormat('en-GB', …)` (a fix-round finding): this is money, and a
 * Brazilian station reading 1234.5 as "1,234.50" instead of "1.234,50" is not
 * a cosmetic gap. `useFormatter` already resolves the reader's own locale the
 * same way `t` does, so `format` is threaded in here rather than reached for
 * globally — a plain function, not a hook, so it stays callable from the
 * render body without its own rules-of-hooks concerns.
 */
function formatAmount(amount: number, format: ReturnType<typeof useFormatter>): string {
  return format.number(amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * One prize's movement history, rendered the same way under all four tabs
 * that have one (Entradas, Saídas, Reservas, Movimentação) — the four lists
 * differ in what they are filtered to (each tab's own `types` argument to
 * `getPrizeMovements`, Task 4/5) and in nothing else, so this is the one
 * place a row's shape is decided.
 *
 * Every field the read (Task 4's `list_movements`) can carry is read here,
 * never recomputed: the reversed state, the reversal's own existence, the
 * remaining quantity on a reservation, and the actor are all values that
 * arrived on the row, not judgements this component makes about it.
 */
export function MovementHistory({
  movements,
  timeZone,
  onReverse,
  emptyMessage,
}: {
  movements: MovementEntry[];
  /** The Station's own zone (spec §7) — every date renders in the zone the movement actually happened in, not the reader's. */
  timeZone: string;
  /** Absent on a tab that offers no archiving/releasing at all (Movimentação, and any tab the caller's own powers do not open a form on). */
  onReverse?: (movement: MovementEntry) => void;
  emptyMessage: string;
}) {
  const t = useTranslations('inventory');
  const format = useFormatter();

  if (movements.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {movements.map((movement) => {
        const reversed = movement.reversedAt !== null;
        const actionKey = onReverse ? actionLabelKey(movement) : null;

        return (
          <li
            key={movement.id}
            data-testid="movement-row"
            className="rounded-md border p-3"
            // The bucket pair, as the enum values themselves rather than
            // their translated names (formatBucket's own rendering, in the
            // paragraph below) — a fix-round finding (Task 9 follow-up, item
            // A): a test asserting only a bare row count could not tell a
            // movement of the wrong quantity or into the wrong bucket from a
            // correct one. `'outside'` is this component's own sentinel for
            // the null a bucket carries to mean "outside the Station"
            // (0026's own column comment), never a value the enum itself has.
            data-from-bucket={movement.fromBucket ?? 'outside'}
            data-to-bucket={movement.toBucket ?? 'outside'}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className={cn('font-medium', reversed && 'line-through')}>
                {t(MOVEMENT_TYPE_LABEL_KEYS[movement.movementType])}
              </span>
              {/*
                `reverses_movement_id` is also set on a RESERVATION_RELEASE
                (design D2: one column serves the entry reversal, the exit
                reversal AND a release alike) — a fix-round finding: gating on
                the column alone put this badge on every release row too,
                reading "Estorno" beside a RESERVATION_RELEASE's own label,
                which is not a reversal of anything in the entry/exit sense
                this badge means. Gated on ENTRY_MOVEMENT_TYPES/
                EXIT_MOVEMENT_TYPES membership instead — the same two arrays
                actionLabelKey (above) already uses to decide whether a row
                offers an Arquivar action at all, so a reversal is exactly a
                MANUAL_EXIT or MANUAL_ENTRY that names the movement it undoes.
              */}
              {movement.reversesMovementId !== null &&
                (ENTRY_MOVEMENT_TYPES.includes(movement.movementType) ||
                  EXIT_MOVEMENT_TYPES.includes(movement.movementType)) && (
                <span
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  data-testid="movement-reversal-badge"
                >
                  {t('reversalOfAnEntry')}
                </span>
              )}
            </div>

            <p className={cn(reversed && 'text-muted-foreground line-through')}>
              {/* The quantity, wrapped alone — the same discipline every
                  other testid in this file follows: the raw number, not the
                  translated "unit(s)" beside it. */}
              <span data-testid="movement-quantity">{movement.quantity}</span>{' '}
              {t('unitsLabel', { count: movement.quantity })}{' '}
              {formatBucket(movement.fromBucket, t)} → {formatBucket(movement.toBucket, t)}
            </p>

            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {/* Wrapped around the raw value alone, not the "By:" label
                  beside it — the only layer that renders who did this
                  (Task 9 brief), and a test asserting on it must not have to
                  match translated copy to reach the name. */}
              <span>
                {t('performedBy')}: <span data-testid="movement-actor">{describeActor(movement, t)}</span>
              </span>
              {/* Block 24, item 8. Before the invoice number rather than after
                  it, because that is the order somebody reading a purchase asks
                  the two questions in: who it came from, then which note it came
                  on. Present on an entry that named a supplier and absent
                  everywhere else, which is the same rule the three fields below
                  already follow.

                  It goes on showing an ARCHIVED supplier's name: list_movements'
                  vendor join is deliberately unfiltered by deleted_at (0200),
                  because a purchase outlives the relationship. */}
              {movement.vendorName !== null && (
                <span>
                  {t('vendor')}: <span data-testid="movement-vendor">{movement.vendorName}</span>
                </span>
              )}
              {movement.invoiceNumber !== null && (
                <span>
                  {t('invoiceNumber')}: <span data-testid="movement-invoice">{movement.invoiceNumber}</span>
                </span>
              )}
              {movement.unitAmount !== null && (
                <span>
                  {t('unitAmount')}: {formatAmount(movement.unitAmount, format)}
                </span>
              )}
              {movement.totalAmount !== null && (
                <span>
                  {t('totalAmount')}: {formatAmount(movement.totalAmount, format)}
                </span>
              )}
              {movement.showName !== null && (
                <span>
                  {t('programme')}: <span data-testid="movement-programme">{movement.showName}</span>
                </span>
              )}
              {movement.remainingQuantity !== null && (
                <span data-testid="movement-remaining">
                  {t('remainingOfReserved', { remaining: movement.remainingQuantity, total: movement.quantity })}
                </span>
              )}
            </div>

            <span className="mt-1 block text-xs text-muted-foreground">
              {formatInstant(movement.createdAt, timeZone)}
              {movement.note ? ` — ${movement.note}` : ''}
            </span>

            {movement.reversedAt !== null && (
              <span className="mt-1 block text-xs text-muted-foreground" data-testid="movement-reversed">
                {t('reversedOn', { date: formatInstant(movement.reversedAt, timeZone) })}
              </span>
            )}

            {onReverse && movement.movementType === 'PROMOTION_LINK' && (
              <p className="mt-2 text-xs text-muted-foreground">{t('unlinkOnThePromotionScreen')}</p>
            )}

            {onReverse && actionKey && (
              <div className="mt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onReverse(movement)}>
                  {t(actionKey)}
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
