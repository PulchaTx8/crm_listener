'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { DrawDetailView } from '@/components/draws/draw-detail';
import { formatInstant } from '../../format';
import { RunDrawDialog, type DrawUnitChoice } from '@/components/draws/run-draw-dialog';
import type { DrawUnitRequest } from '@/components/draws/run-draw-dialog';
import type { DrawDetail, DrawSummary } from '@/services/draws';
import type { WinnerAction, WinnerPowers } from '@/components/draws/winner-actions';
import { attachReceiptAction, cancelDrawAction, runDrawAction, winnerActionAction } from './actions';

/**
 * The client half of the draws route: the list of draws down one side, the
 * selected one beside it, and the button that runs a new one.
 *
 * Which draw is open lives in the URL (`?draw=`) rather than in state, so a
 * link to a particular draw is a link somebody can send — the same reasoning
 * ?record= carries on the list screens.
 */
export function DrawsScreen({
  promotionId,
  draws,
  detail,
  linked,
  timeZone,
  canDraw,
  canCancel,
  winnerPowers,
  receiptUrls,
  companyId,
}: {
  promotionId: string;
  companyId: string;
  /** The Station's zone: every instant on this screen is the one the Station ran on. */
  timeZone: string;
  draws: DrawSummary[];
  detail: DrawDetail | null;
  linked: DrawUnitChoice[];
  canDraw: boolean;
  canCancel: boolean;
  winnerPowers: WinnerPowers;
  receiptUrls: Record<string, string>;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-3">
        <h2 className="font-medium">Draws</h2>
        {draws.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-draws">
            This promotion has not been drawn yet.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="draw-list">
            {draws.map((draw) => (
              <li key={draw.id}>
                <Link
                  href={`/promotions/${promotionId}/draws?draw=${draw.id}` as Route}
                  className={`block rounded border px-2 py-1 text-sm ${
                    detail?.id === draw.id ? 'border-primary font-medium' : ''
                  }`}
                >
                  {formatInstant(draw.drawnAt, timeZone)}
                  <span className="ml-1 text-muted-foreground">
                    · {draw.winnerCount} prize{draw.winnerCount === 1 ? '' : 's'}
                    {draw.status === 'CANCELLED' ? ' · cancelled' : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {canDraw ? (
          linked.length > 0 ? (
            <div className="border-t pt-3">
              <h3 className="mb-2 font-medium">New draw</h3>
              <RunDrawDialog
                linked={linked}
                onRun={(units: DrawUnitRequest[] | null) => runDrawAction(promotionId, units)}
              />
            </div>
          ) : (
            <p className="border-t pt-3 text-sm text-muted-foreground" data-testid="nothing-to-draw">
              There are no linked units left to draw.
            </p>
          )
        ) : null}
      </aside>

      <div>
        {detail ? (
          <DrawDetailView
            draw={detail}
            timeZone={timeZone}
            canCancel={canCancel}
            onCancel={(reason: string) => cancelDrawAction(promotionId, detail.id, reason)}
            winnerPowers={winnerPowers}
            receiptUrls={receiptUrls}
            onWinnerAction={(winnerId: string, action: WinnerAction, reason: string) =>
              winnerActionAction(promotionId, winnerId, action, reason)
            }
            onAttachReceipt={(winnerId: string, formData: FormData) =>
              attachReceiptAction(promotionId, winnerId, companyId, formData)
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">No draw selected.</p>
        )}
      </div>
    </div>
  );
}
