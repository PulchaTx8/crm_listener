'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DrawDetail } from '@/services/draws';

function formatDeadline(value: string | null): string {
  // Null is not missing data: it means this winner has NO deadline, because
  // neither the promotion nor the prize set one (spec 6). Saying "sem prazo"
  // is the whole point — a blank would read as a value nobody filled in.
  if (!value) return 'sem prazo';
  return new Date(value).toLocaleDateString('pt-BR');
}

/**
 * A listener with no name on record still has to be distinguishable from the
 * next one. members.full_name is nullable (0031) and an erased listener is the
 * ordinary way this happens — get_draw returns the name to anybody who may see
 * the draw at all, so a blank here is never "you are not allowed to know".
 */
function listenerLabel(name: string | null, memberId: string): string {
  return name ?? `ouvinte ${memberId.slice(0, 8)} (sem nome no cadastro)`;
}

/**
 * The winners with their deadlines, the runner-up queue in order, and — plainly,
 * not behind a toggle — the seed and the algorithm version.
 *
 * That last part is the block's whole claim: a draw is checkable because
 * anybody holding the record can recompute it. A proof nobody can see is not a
 * proof, so it is on the screen next to the winners rather than in an export
 * somebody has to know to ask for.
 */
export function DrawDetailView({
  draw,
  canCancel,
  onCancel,
}: {
  draw: DrawDetail;
  canCancel: boolean;
  onCancel: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelled = draw.status === 'CANCELLED';

  function submitCancel() {
    if (reason.trim().length === 0) {
      setMessage('Informe o motivo do cancelamento.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const failure = await onCancel(reason);
      if (failure) setMessage(failure);
    });
  }

  return (
    <section className="space-y-6" data-testid="draw-detail">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">
          Sorteio de {new Date(draw.drawnAt).toLocaleString('pt-BR')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {draw.entryCount} entrada(s) no chapéu · {draw.winners.length} prêmio(s) ·{' '}
          {draw.runnersUp.length} suplente(s)
        </p>
        {cancelled ? (
          <p className="text-sm font-medium text-destructive" data-testid="draw-cancelled">
            Cancelado em {draw.cancelledAt ? new Date(draw.cancelledAt).toLocaleString('pt-BR') : ''}
            {draw.cancellationReason ? ` — ${draw.cancellationReason}` : ''}
          </p>
        ) : null}
      </header>

      <div>
        <h3 className="mb-2 font-medium">Ganhadores</h3>
        <ol className="space-y-1" data-testid="draw-winners">
          {draw.winners.map((winner) => (
            <li key={winner.id} className="flex justify-between gap-4 border-b py-1">
              <span>
                {winner.awardedRank}. {listenerLabel(winner.memberName, winner.memberId)}
              </span>
              <span className="text-sm text-muted-foreground">
                {winner.prizeName} · {formatDeadline(winner.deadlineAt)}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {draw.runnersUp.length > 0 ? (
        <div>
          <h3 className="mb-2 font-medium">Suplentes, na ordem</h3>
          <ol className="space-y-1" data-testid="draw-runners-up">
            {draw.runnersUp.map((runnerUp) => (
              <li key={runnerUp.participationId} className="py-1">
                {runnerUp.position}. {listenerLabel(runnerUp.memberName, runnerUp.memberId)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="rounded border p-3 text-sm">
        <h3 className="mb-1 font-medium">Como conferir este sorteio</h3>
        <p className="text-muted-foreground">
          Ordene as entradas por <code>sha256(semente + &quot;:&quot; + id da participação)</code> e
          percorra a lista, pulando quem já ganhou. O runbook traz a receita completa.
        </p>
        <dl className="mt-2 space-y-1">
          <div className="flex gap-2">
            <dt className="font-medium">Semente</dt>
            <dd>
              <code data-testid="draw-seed" className="break-all">
                {draw.seed}
              </code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Algoritmo</dt>
            <dd data-testid="draw-algorithm-version">v{draw.algorithmVersion}</dd>
          </div>
        </dl>
      </div>

      {canCancel && !cancelled ? (
        <div className="space-y-2 border-t pt-4">
          <label className="block text-sm font-medium" htmlFor="cancel-reason">
            Cancelar este sorteio
          </label>
          <Input
            id="cancel-reason"
            value={reason}
            placeholder="Motivo do cancelamento"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            type="button"
            variant="destructive"
            onClick={submitCancel}
            disabled={pending}
            data-testid="cancel-draw"
          >
            {pending ? 'Cancelando…' : 'Cancelar sorteio'}
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}
