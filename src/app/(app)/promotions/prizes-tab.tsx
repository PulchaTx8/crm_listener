'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
// The constant comes from @/lib rather than from @/services/promotions, which
// exports it too: that module is `server-only`, and a value import from a
// client component pulls the whole thing — Supabase admin client included —
// into the browser bundle. The type imports below are erased at compile time
// and are safe from either place, which is why quiz-tab.tsx can take its own
// from the service.
import { LINKABLE_PRIZE_PAGE_SIZE } from '@/lib/linkable-prizes';
import type { LinkablePrize, PromotionPrizeRow } from '@/services/promotions';
import {
  linkPrizeAction,
  searchLinkablePrizesAction,
  unlinkPrizeAction,
  type PrizeLinkState,
} from './actions';

const INITIAL: PrizeLinkState = { status: 'idle' };

/**
 * The same figure every filter on every list screen in this app debounces at
 * (inventory-filters.tsx, members-filters.tsx, promotions-filters.tsx all carry
 * `const DEBOUNCE_MS = 350`). Repeated rather than imported because those three
 * are each a list's own navigation delay and this is a picker's server round
 * trip; sharing one constant would tie two unrelated decisions together, and the
 * next person to tune either would move both.
 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Vinculados / Sorteados / Resto, one row per linked prize, plus the two
 * controls that move units in and out.
 *
 * Resto is computed here and stored nowhere: a stored total is one more thing
 * that can disagree with its parts, and this one has two parts that are already
 * reconciled against the ledger.
 *
 * Every write calls `onSaved`, which re-reads this one record. That is not a
 * hole in the rule this screen rests on: the prohibition is on re-running the
 * LIST, not on reading one record again, and nothing behind the dialog is
 * re-rendered.
 */
export function PrizesTab({
  promotionId,
  companyId,
  prizes,
  canLink,
  onSaved,
}: {
  promotionId: string;
  companyId: string;
  prizes: PromotionPrizeRow[];
  canLink: boolean;
  onSaved: () => void;
}) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {prizes.length === 0 && !linking && (
        <p className="text-sm text-muted-foreground">
          No prize is linked to this promotion yet. A promotion can run without one, but nothing can
          be drawn from it.
        </p>
      )}

      {prizes.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Prize</th>
                <th className="px-3 py-2 font-medium">Linked</th>
                <th className="px-3 py-2 font-medium">Drawn</th>
                <th className="px-3 py-2 font-medium">Left</th>
                {/* The header text is hidden, not the header cell: `sr-only` is
                    `position: absolute`, so putting it on the `th` itself takes
                    the cell out of the table's column algorithm and leaves a
                    header row one column shorter than every body row. The span
                    keeps the column in flow and still gives the control a name
                    a screen reader can announce. */}
                {canLink && (
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Return to stock</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {prizes.map((row) => (
                <tr
                  key={row.promotionPrizeId}
                  className="border-b last:border-0"
                  data-testid="promotion-prize-row"
                >
                  <td className="px-3 py-2">{row.prizeName}</td>
                  <td className="px-3 py-2" data-testid="promotion-prize-linked">
                    {row.linked}
                  </td>
                  <td className="px-3 py-2" data-testid="promotion-prize-drawn">
                    {row.drawn}
                  </td>
                  <td className="px-3 py-2" data-testid="promotion-prize-left">
                    {row.linked - row.drawn}
                  </td>
                  {canLink && (
                    <td className="px-3 py-2">
                      <UnlinkControl
                        promotionId={promotionId}
                        prizeId={row.prizeId}
                        prizeName={row.prizeName}
                        free={row.linked - row.drawn}
                        onSaved={onSaved}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canLink && !linking && (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLinking(true)}
            data-testid="prize-link-open"
          >
            Link a prize
          </Button>
        </div>
      )}

      {canLink && linking && (
        <LinkForm
          promotionId={promotionId}
          companyId={companyId}
          onCancel={() => setLinking(false)}
          onSaved={() => {
            setLinking(false);
            onSaved();
          }}
        />
      )}

      {!canLink && (
        <p className="text-sm text-muted-foreground">
          You do not hold promotions.prizes at this Station, so what is linked can be read here but
          not changed.
        </p>
      )}
    </div>
  );
}

/**
 * Bounded by Resto rather than by Vinculados: the drawn units belong to a
 * winner. The RPC refuses the same thing and names both figures, so this is the
 * verdict without a round trip and not the boundary.
 *
 * The prize's NAME goes into both accessible names, which is the precedent
 * inventory-grid.tsx sets with `aria-label={`Edit ${prize.name}`}`. Before this,
 * every row on a tab with several prizes linked offered a screen reader the same
 * two names — "Units to return to stock", "Return" — with nothing to say which
 * prize either belonged to.
 *
 * The prize's ID, not its name, goes into the three test ids. Same defect, same
 * fix, different key on purpose: the ids were duplicated across rows and worked
 * only because the e2e links exactly one prize, so the first person to link two
 * in a test got a Playwright strict-mode violation that reads as their own bug —
 * but nothing in the schema makes a prize's name unique within a Station, so
 * keying on the name would leave that violation reachable, and a rename would
 * move every selector. The id is unique by construction and stable.
 */
function UnlinkControl({
  promotionId,
  prizeId,
  prizeName,
  free,
  onSaved,
}: {
  promotionId: string;
  prizeId: string;
  prizeName: string;
  free: number;
  onSaved: () => void;
}) {
  const [state, action, pending] = useActionState(unlinkPrizeAction, INITIAL);
  const [quantity, setQuantity] = useState('1');

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (free === 0) {
    return <span className="text-xs text-muted-foreground">All drawn</span>;
  }

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="promotionId" value={promotionId} />
      <input type="hidden" name="prizeId" value={prizeId} />
      <Input
        name="quantity"
        type="number"
        min={1}
        max={free}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        aria-label={`Units of ${prizeName} to return to stock`}
        className="w-20"
        data-testid={`prize-unlink-quantity-${prizeId}`}
      />
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
        aria-label={`Return ${prizeName} to stock`}
        data-testid={`prize-unlink-${prizeId}`}
      >
        {pending ? 'Returning…' : 'Return'}
      </Button>
      {state.status === 'error' && (
        <span
          className="text-xs text-destructive"
          data-testid={`prize-unlink-error-${prizeId}`}
        >
          {state.message}
        </span>
      )}
    </form>
  );
}

function LinkForm({
  promotionId,
  companyId,
  onCancel,
  onSaved,
}: {
  promotionId: string;
  companyId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, action, pending] = useActionState(linkPrizeAction, INITIAL);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<LinkablePrize[]>([]);
  const [cut, setCut] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Debounced, because this runs per keystroke and each run is a server round
  // trip.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      startLoading(async () => {
        const result = await searchLinkablePrizesAction(companyId, search);
        // The answer to a term the operator has already typed past must not
        // land. The debounce narrows that window and does not close it: two
        // requests can be in flight at once whenever one is slower than the
        // pause between two keystrokes, and the older one resolving last would
        // leave the picker showing results for a term the search box no longer
        // holds. Same guard, and the same `current` flag, the record dialog
        // uses for its own read.
        if (!current) return;
        if (result.status === 'ok') {
          setOptions(result.page.prizes);
          setCut(result.page.hasMore);
          setFailure(null);
          return;
        }
        setOptions([]);
        setCut(false);
        setFailure(result.message);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [companyId, search]);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-md border p-4"
      data-testid="prize-link-form"
    >
      <input type="hidden" name="promotionId" value={promotionId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Find a prize</span>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Part of the name"
          data-testid="prize-link-search"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Prize</span>
        <Select name="prizeId" required data-testid="prize-link-select">
          <option value="">Choose a prize…</option>
          {options.map((prize) => (
            <option key={prize.prizeId} value={prize.prizeId}>
              {prize.name} — {prize.available} available
            </option>
          ))}
        </Select>
        {/* No silent caps: a list that stops must say so, or an operator
            hunting for the prize that is not there concludes it is gone.
            Driven by the service's own hasMore — which comes from the RPC
            returning one row past the page — rather than from a full page,
            because a Station holding exactly fifty prizes would otherwise be
            told about a truncation that did not happen. */}
        {cut && (
          <span className="text-xs text-muted-foreground" data-testid="prize-link-cut">
            Showing the first {LINKABLE_PRIZE_PAGE_SIZE}. Narrow the search to reach the rest.
          </span>
        )}
        {loading && <span className="text-xs text-muted-foreground">Looking…</span>}
        {failure && <span className="text-xs text-destructive">{failure}</span>}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Units</span>
        <Input
          name="quantity"
          type="number"
          min={1}
          defaultValue={1}
          required
          className="w-28"
          data-testid="prize-link-quantity"
        />
      </label>

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="prize-link-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} data-testid="prize-link-save">
          {pending ? 'Linking…' : 'Link'}
        </Button>
      </div>
    </form>
  );
}
