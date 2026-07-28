'use client';

import { useActionState } from 'react';
import { runReconciliationAction, type ReconciliationState } from './actions';
import { Button } from '@/components/ui/button';
import { formatBucketName, formatDateTime } from './format';

const INITIAL: ReconciliationState = { status: 'idle' };

/**
 * A button and a result — nothing else. Success has two distinct shapes, both
 * rendered explicitly rather than one being a fallthrough of the other: an
 * empty `rows` array is "no divergence, checked at this time," and a non-empty
 * one is exactly the rows reconcile_inventory (0028) found disagreeing, each
 * naming the prize, the bucket, the stored figure and the computed one. No
 * query flag is used for the error state — the result lives entirely in
 * useActionState's own state, so there is nothing that could survive to a
 * later, successful check the way a stale ?error= query param could.
 */
export function ReconciliationPanel({ companyId }: { companyId: string }) {
  const [state, action, pending] = useActionState(runReconciliationAction, INITIAL);

  return (
    <form action={action} data-testid="reconciliation-panel" className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Run reconciliation'}
        </Button>
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}

      {state.status === 'checked' && state.rows && state.rows.length === 0 && (
        <p className="text-sm text-emerald-700">
          No divergence found, checked {formatDateTime(state.checkedAt as string)}.
        </p>
      )}

      {state.status === 'checked' && state.rows && state.rows.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-destructive">
            {state.rows.length} row(s) disagree, checked {formatDateTime(state.checkedAt as string)}.
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Prize</th>
                  <th className="px-3 py-2 font-medium">Bucket</th>
                  <th className="px-3 py-2 font-medium">Stored</th>
                  <th className="px-3 py-2 font-medium">Computed</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row, index) => (
                  <tr
                    key={`${row.prizeId}-${row.bucket}-${index}`}
                    data-testid="reconciliation-row"
                    className="border-b last:border-0"
                  >
                    <td className="px-3 py-2">{row.prizeName}</td>
                    <td className="px-3 py-2">{formatBucketName(row.bucket)}</td>
                    <td className="px-3 py-2">{row.stored}</td>
                    <td className="px-3 py-2">{row.computed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </form>
  );
}
