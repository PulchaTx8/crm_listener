'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** One linked prize as the dialog offers it: what is left, and what was asked for. */
export interface DrawUnitChoice {
  promotionPrizeId: string;
  prizeName: string;
  /** linked - drawn, as the balances stood when this dialog rendered. */
  available: number;
  requested: number;
}

export interface DrawUnitRequest {
  promotionPrizeId: string;
  quantity: number;
}

export type DrawRequestResult =
  | { ok: true; units: DrawUnitRequest[] | null }
  | { ok: false; message: string };

/**
 * A ceiling on the runner-up count, so a mistyped number cannot ask for a queue
 * longer than any hat this system will ever hold. Arbitrary and deliberate, the
 * way promotions_repetition_shape's 8760 hours is: without one, a stray digit
 * turns a queue of three into a queue of three hundred and the draw quietly
 * writes every remaining listener into it.
 */
export const DRAW_RUNNER_UP_MAX = 50;

/**
 * What the dialog will and will not send.
 *
 * A COURTESY, never the boundary: apply_draw (0078) refuses a shortfall with
 * 22023 whatever this returns, and it is the one that counts, because the
 * balances can move between this dialog rendering and its Submit. What this
 * buys is a sentence naming the prize, in the operator's language, before a
 * round trip.
 *
 * `allTaken` is how the caller says the operator narrowed nothing. It returns
 * null units, which is what run_draw reads as "every unit still available on
 * every live link" (D8) — resolved server-side from the balances rather than
 * from whatever this screen last read, so the default cannot be stale.
 */
export function validateDrawRequest(input: {
  units: DrawUnitChoice[];
  runnerUpCount: number;
  allTaken?: boolean;
}): DrawRequestResult {
  const { units, runnerUpCount, allTaken = false } = input;

  if (!Number.isInteger(runnerUpCount) || runnerUpCount < 0) {
    return { ok: false, message: 'O número de suplentes não pode ser negativo.' };
  }
  if (runnerUpCount > DRAW_RUNNER_UP_MAX) {
    return { ok: false, message: `No máximo ${DRAW_RUNNER_UP_MAX} suplentes.` };
  }

  for (const unit of units) {
    if (!Number.isInteger(unit.requested) || unit.requested < 0) {
      return {
        ok: false,
        message: `A quantidade de "${unit.prizeName}" tem de ser um número inteiro.`,
      };
    }
    if (unit.requested > unit.available) {
      return {
        ok: false,
        message: `"${unit.prizeName}" tem ${unit.available} unidade(s) para sortear.`,
      };
    }
  }

  // A row left at zero is the operator declining that prize, not asking for
  // none of it: run_draw refuses quantity 0 with 22023, so it is dropped here
  // rather than sent.
  const asked = units.filter((unit) => unit.requested > 0);
  if (asked.length === 0) {
    return { ok: false, message: 'Escolha pelo menos uma unidade para sortear.' };
  }

  if (allTaken) return { ok: true, units: null };

  return {
    ok: true,
    units: asked.map((unit) => ({
      promotionPrizeId: unit.promotionPrizeId,
      quantity: unit.requested,
    })),
  };
}

/**
 * How many of each prize, how many runners-up, and the button.
 *
 * The counts it offers come from the balances the page read; the refusal that
 * matters comes from the database. Both are shown to the operator.
 */
export function RunDrawDialog({
  linked,
  defaultRunnerUpCount,
  onRun,
  disabled,
}: {
  linked: DrawUnitChoice[];
  defaultRunnerUpCount: number;
  onRun: (units: DrawUnitRequest[] | null, runnerUpCount: number) => Promise<string | null>;
  disabled?: boolean;
}) {
  const [choices, setChoices] = useState<DrawUnitChoice[]>(linked);
  const [runnerUpCount, setRunnerUpCount] = useState(defaultRunnerUpCount);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allTaken = choices.every((unit) => unit.requested === unit.available);

  function submit() {
    const validated = validateDrawRequest({ units: choices, runnerUpCount, allTaken });
    if (!validated.ok) {
      setMessage(validated.message);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const failure = await onRun(validated.units, runnerUpCount);
      if (failure) setMessage(failure);
    });
  }

  return (
    <div className="space-y-4" data-testid="run-draw-dialog">
      <div className="space-y-2">
        {choices.map((unit, index) => (
          <label key={unit.promotionPrizeId} className="flex items-center justify-between gap-3">
            <span>
              {unit.prizeName}
              <span className="ml-2 text-sm text-muted-foreground">
                {unit.available} para sortear
              </span>
            </span>
            <Input
              type="number"
              min={0}
              max={unit.available}
              value={unit.requested}
              aria-label={`Unidades de ${unit.prizeName}`}
              onChange={(event) =>
                setChoices((current) =>
                  current.map((row, i) =>
                    i === index ? { ...row, requested: Number(event.target.value) } : row,
                  ),
                )
              }
              className="w-24"
            />
          </label>
        ))}
      </div>

      <label className="flex items-center justify-between gap-3">
        <span>Suplentes</span>
        <Input
          type="number"
          min={0}
          max={DRAW_RUNNER_UP_MAX}
          value={runnerUpCount}
          aria-label="Número de suplentes"
          onChange={(event) => setRunnerUpCount(Number(event.target.value))}
          className="w-24"
        />
      </label>

      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}

      <Button type="button" onClick={submit} disabled={disabled || pending} data-testid="run-draw">
        {pending ? 'Sorteando…' : 'Sortear'}
      </Button>
    </div>
  );
}
