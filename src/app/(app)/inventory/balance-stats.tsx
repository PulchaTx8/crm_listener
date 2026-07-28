import type { PrizeBalance } from '@/services/inventory';
import { physicalTotal } from './format';

/**
 * The bucket breakdown, identical on the list row and the detail page so the
 * two screens cannot silently disagree about what "the balance" means — one
 * component computing and rendering it, rather than two copies of the same
 * arithmetic. `delivered` and `written_off` render in their own row below a
 * divider, because they are cumulative counters outside physical stock
 * (design spec §4) — folding them into the row above would silently overstate
 * the total.
 */
export function BalanceStats({ balance, compact }: { balance: PrizeBalance; compact?: boolean }) {
  const physical = physicalTotal(balance);
  return (
    <div className="flex flex-col gap-2">
      <div
        className={
          compact
            ? 'flex flex-wrap gap-x-6 gap-y-2 text-sm'
            : 'flex flex-wrap gap-x-8 gap-y-3 text-sm'
        }
      >
        <Stat label="Available" value={balance.available} />
        <Stat label="Reserved" value={balance.reserved} />
        <Stat label="Linked" value={balance.linked} />
        <Stat label="Awaiting pickup" value={balance.awaitingPickup} />
        <Stat label="Pending return" value={balance.pendingReturn} />
        <Stat label="Physical total" value={physical} emphasize />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span>Delivered (cumulative, outside physical stock): {balance.delivered}</span>
        <span>Written off (cumulative, outside physical stock): {balance.writtenOff}</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: number;
  emphasize?: boolean;
}) {
  return (
    <span className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={emphasize ? 'text-base font-semibold' : ''}>{value}</span>
    </span>
  );
}
