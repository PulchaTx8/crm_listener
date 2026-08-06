'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MERGE_REASON_MAX_LENGTH } from '@/schemas/music';
import type { MusicMergeKind } from '@/schemas/music';
import type { MergeCandidate } from '@/services/music';
import { maintenanceHref } from './list-params';
import type { MaintenanceState } from './list-params';
import { mergeRecordsAction } from './actions';
import type { MergeState } from './actions';

const DEBOUNCE_MS = 350;

/**
 * Duplicated from page.tsx's own kind→label map rather than imported, for
 * the same boundary reason reference-tabs.tsx's header gives for
 * CatalogTab: this is a 'use client' module and page.tsx is a Server
 * Component, and importing a runtime value out of a client module from a
 * Server Component turns it into an opaque client reference rather than the
 * value itself. Both copies are exhaustive over MUSIC_MERGE_KINDS, so they
 * cannot silently drift apart — a renamed kind is a type error in both
 * places at once, not a quiet bug in one of them.
 */
const KIND_LABELS: Record<MusicMergeKind, string> = {
  SONG: 'songs',
  ARTIST: 'artists',
  LABEL: 'labels',
  GENRE: 'genres',
  SHOW: 'shows',
};

/**
 * What a merge of this kind actually moves — 0108's own repoint target
 * (list_merge_candidates.sql): merge_songs and merge_shows both repoint
 * music_requests, merge_artists/merge_record_labels/merge_music_genres all
 * repoint songs. This is what turns a bare childCount into "412 requests" —
 * the number that makes naming the survivor a decision, not a coin flip.
 */
const CHILD_NOUN: Record<MusicMergeKind, string> = {
  SONG: 'requests',
  ARTIST: 'songs',
  LABEL: 'songs',
  GENRE: 'songs',
  SHOW: 'requests',
};

/** "412 requests", "3 songs", "0 songs" — singular only at exactly one, and the codebase's own `en-GB` thousands grouping (PageControls' identical `toLocaleString('en-GB')`). */
export function childCountLabel(kind: MusicMergeKind, count: number): string {
  const noun = CHILD_NOUN[kind];
  const word = count === 1 ? noun.slice(0, -1) : noun;
  return `${count.toLocaleString('en-GB')} ${word}`;
}

// ---------------------------------------------------------------------------
// The staging area's own state machine — pure and independent of React, on
// purpose: §5.1 of the design spec says the staging area IS React state and
// nothing else (it disappears if the operator leaves, and that is
// deliberate, not a gap), and a plain reducer is what lets that rule be
// tested without a browser or a database. Exported for
// tests/unit/music-merge-staging.test.ts.
// ---------------------------------------------------------------------------

export interface StagingState {
  /**
   * The ticked rows, in the order they were ticked — full candidates, not
   * just ids. A later search replaces `candidates` (page.tsx's own prop)
   * with a fresh server read for the same kind, and an already-staged row
   * that fell out of that page must not vanish from its own staging area
   * because of it.
   */
  staged: MergeCandidate[];
  /** One of `staged`'s own ids, or null before the operator has named one. */
  survivorId: string | null;
}

export const EMPTY_STAGING: StagingState = { staged: [], survivorId: null };

export type StagingAction =
  | { type: 'toggle'; candidate: MergeCandidate }
  | { type: 'remove'; id: string }
  | { type: 'name-survivor'; id: string }
  | { type: 'reset' };

function withoutId(state: StagingState, id: string): StagingState {
  return {
    staged: state.staged.filter((c) => c.id !== id),
    // The survivor named so far stops meaning anything the instant its own
    // row leaves staging — left set, the confirmation dialog (and the
    // submit itself) could go on naming a record no longer in the basket.
    survivorId: state.survivorId === id ? null : state.survivorId,
  };
}

export function stagingReducer(state: StagingState, action: StagingAction): StagingState {
  switch (action.type) {
    case 'toggle':
      return state.staged.some((c) => c.id === action.candidate.id)
        ? withoutId(state, action.candidate.id)
        : { ...state, staged: [...state.staged, action.candidate] };
    case 'remove':
      return withoutId(state, action.id);
    case 'name-survivor':
      // The radio only ever renders inside the staging area, so a click can
      // never reach this with an id that is not staged — checked anyway as
      // the reducer's own contract, not trusted to the one caller that
      // exists today.
      return state.staged.some((c) => c.id === action.id)
        ? { ...state, survivorId: action.id }
        : state;
    case 'reset':
      return EMPTY_STAGING;
    default:
      return state;
  }
}

/** Every staged row except the one named to stay — 0106's own `loserIds`. */
export function losersOf(state: StagingState): MergeCandidate[] {
  return state.staged.filter((c) => c.id !== state.survivorId);
}

/** Mirrors mergeFormSchema's own two live refusals (an empty loser list, a missing survivor) — checked here so the button can say no before the round trip. */
export function canSubmitMerge(state: StagingState): boolean {
  return state.survivorId !== null && losersOf(state).length > 0;
}

/** Sums only the LOSERS: the winner's own children already point at it, and counting them in would claim the merge moves more than it does. */
export function childrenMovedByMerge(losers: readonly MergeCandidate[]): number {
  return losers.reduce((sum, loser) => sum + loser.childCount, 0);
}

/**
 * The confirmation sentence naming the real numbers — the task brief's own
 * example ("Merge 2 records into «Sozinho»? 412 requests will move. This
 * cannot be undone."), in this codebase's own curly-quote house style
 * (NoStationMatch, ArchiveReferenceDialog) rather than the brief's
 * illustrative guillemets.
 */
export function mergeConfirmationText(
  kind: MusicMergeKind,
  survivor: MergeCandidate,
  losers: readonly MergeCandidate[],
): string {
  const moved = childrenMovedByMerge(losers);
  const record = losers.length === 1 ? 'record' : 'records';
  return `Merge ${losers.length} ${record} into “${survivor.label}”? ${childCountLabel(kind, moved)} will move. This cannot be undone.`;
}

const INITIAL_MERGE: MergeState = { ok: null };

/**
 * The Maintenance screen's whole interactive half: search, tick, stage, name
 * a survivor, give a reason, merge. `candidates` arrives already read by
 * page.tsx for the current kind and search — this component reads nothing
 * on its own.
 *
 * `canMerge` false renders the list read-only — no checkboxes, no staging,
 * no reason field — with an explanation, instead of page.tsx redirecting: an
 * operator without music.merge can still see the duplicates and learn what
 * they are missing, which is more useful than a bounce to /app.
 *
 * page.tsx keys this component on `` `${state.companyId}:${state.kind}` ``,
 * not `kind` alone — `kind` alone was the Critical page.tsx's own comment
 * describes at length: it remounts on a kind switch but not on a Station
 * switch (the Company badge is a soft `<Link>` to this same route), so a
 * staged basket could survive a Station change and merge the wrong
 * Station's pair. Both fields together is what stops one screen's
 * half-built basket from bleeding into another's, whether the operator
 * changed kind, Station, or both.
 */
export function MergePanel({
  state,
  candidates,
  canMerge,
}: {
  state: MaintenanceState;
  candidates: MergeCandidate[];
  canMerge: boolean;
}) {
  const t = useTranslations('music');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input
  // agreeing with the list beside it — the same effect songs-filters.tsx and
  // requests-filters.tsx both carry for the identical reason.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<MaintenanceState>) {
    clearTimeout(timer.current);
    const typed: MaintenanceState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(maintenanceHref({ ...typed, ...next }) as Route);
  }

  const [staging, dispatch] = useReducer(stagingReducer, EMPTY_STAGING);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Fix round 1, Minor: ConfirmMergeDialog unmounts (and its useActionState
  // with it) the instant `confirming` goes false — including on a plain ESC
  // or backdrop click, which closes the dialog exactly the same as the
  // "Cancel" button does. Without this, a FAILED merge attempt vanished
  // without a trace the moment the dialog closed: the operator was left
  // looking at the same full basket with nothing on screen saying a merge
  // was tried and refused. Captured via the dialog's own `onFailed` the
  // instant the action returns `ok: false` — not only on dismissal — so it
  // survives every dismissal path, not just the ones this file happens to
  // enumerate.
  const [lastFailure, setLastFailure] = useState<string | null>(null);

  const losers = losersOf(staging);
  const survivor = staging.staged.find((c) => c.id === staging.survivorId) ?? null;
  const kindLabel = KIND_LABELS[state.kind];
  const stagedIds = new Set(staging.staged.map((c) => c.id));

  return (
    <div className="flex flex-col gap-6">
      {!canMerge && (
        <p
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="maintenance-readonly-notice"
        >
          {t('youCanSeeThisStationS')}{' '}{kindLabel}, but merging them needs a permission you do
          not hold here — <strong>{t('musicMerge')}</strong>. Ask somebody who holds it to collapse the
          duplicates, or to grant it to you.
        </p>
      )}

      <label className="flex w-72 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}{' '}{kindLabel}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder={t('name')}
          aria-label={`Search ${kindLabel} by name`}
          data-testid="maintenance-search-input"
        />
      </label>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {canMerge && (
                <TableHead>
                  <span className="sr-only">{t('stageForMerge')}</span>
                </TableHead>
              )}
              <TableHead>{t('name')}</TableHead>
              {/* Uppercased by TableHead's own CSS regardless of the case
                  passed in — no need to capitalise CHILD_NOUN by hand. */}
              <TableHead>{CHILD_NOUN[state.kind]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canMerge ? 3 : 2}
                  className="py-8 text-center text-muted-foreground"
                >
                  {state.search ? `No ${kindLabel} match “${state.search}”.` : `No ${kindLabel} yet.`}
                </TableCell>
              </TableRow>
            ) : (
              candidates.map((candidate) => (
                <TableRow key={candidate.id} data-testid="maintenance-candidate-row">
                  {canMerge && (
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={stagedIds.has(candidate.id)}
                        onChange={() => dispatch({ type: 'toggle', candidate })}
                        aria-label={`Stage ${candidate.label} for merge`}
                        data-testid="maintenance-candidate-checkbox"
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <span className="text-sm">{candidate.label}</span>
                    {candidate.subLabel && (
                      <span className="ml-2 text-xs text-muted-foreground">{candidate.subLabel}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {childCountLabel(state.kind, candidate.childCount)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {canMerge && staging.staged.length > 0 && (
        <div className="rounded-md border p-3" data-testid="maintenance-staging-area">
          <h3 className="mb-2 text-sm font-medium">{t('stagedForMerge')}</h3>
          <ul className="flex flex-col divide-y">
            {staging.staged.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
                data-testid="maintenance-staging-row"
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="maintenance-survivor"
                    checked={staging.survivorId === candidate.id}
                    onChange={() => dispatch({ type: 'name-survivor', id: candidate.id })}
                    data-testid="maintenance-survivor-radio"
                  />
                  <span className="flex flex-col">
                    <span>
                      {candidate.label}
                      {candidate.subLabel && (
                        <span className="ml-2 text-xs text-muted-foreground">{candidate.subLabel}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {childCountLabel(state.kind, candidate.childCount)}
                    </span>
                  </span>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => dispatch({ type: 'remove', id: candidate.id })}
                  data-testid="maintenance-staging-remove"
                >
                  {t('remove')}</Button>
              </li>
            ))}
          </ul>
          {staging.survivorId === null && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('pickWhichOneStaysTheRadio')}</p>
          )}
        </div>
      )}

      {canMerge && (
        <form
          className="flex flex-col items-start gap-3"
          onSubmit={(e) => {
            // Nothing here posts anywhere: this form exists only so the
            // browser's own `required` validation on the Textarea blocks a
            // blank reason with a native prompt before the confirmation
            // dialog — naming the consequence of a merge with no reason
            // typed yet would be showing a promise this submit could not
            // keep. `canSubmitMerge` covers the other two refusals
            // (mergeFormSchema's own: a missing survivor, an empty loser
            // list).
            e.preventDefault();
            // A fresh attempt starts clean — the banner below would
            // otherwise sit under a brand-new, not-yet-resolved
            // confirmation showing a refusal from a previous one.
            setLastFailure(null);
            setConfirming(true);
          }}
        >
          <label className="flex w-full max-w-xl flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('reason')}</span>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MERGE_REASON_MAX_LENGTH}
              required
              placeholder={t('sayWhyTheseAreTheSame')}
              data-testid="maintenance-reason"
            />
          </label>
          {/* Small on purpose: this is the only destructive, irreversible
              action in the whole Music domain, and the button that opens
              its confirmation should not read as an inviting, ordinary
              submit. */}
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmitMerge(staging)}
            data-testid="maintenance-merge-button"
          >
            {t('merge')}</Button>
          {lastFailure && (
            <p className="text-sm text-destructive" data-testid="maintenance-merge-last-error">
              {lastFailure}
            </p>
          )}
        </form>
      )}

      {confirming && survivor && (
        <ConfirmMergeDialog
          companyId={state.companyId}
          kind={state.kind}
          survivor={survivor}
          losers={losers}
          reason={reason}
          onCancel={() => setConfirming(false)}
          onFailed={(message) => setLastFailure(message)}
          onDone={() => {
            setConfirming(false);
            setLastFailure(null);
            dispatch({ type: 'reset' });
            setReason('');
          }}
        />
      )}
    </div>
  );
}

/**
 * Names the consequence in real numbers before the click, on the
 * ArchiveReferenceDialog shape: a styled `<Dialog>`, not `window.confirm`.
 *
 * Stays open through a successful merge rather than closing itself: the
 * count `mergeRecordsAction` returns is the operator's only receipt that the
 * merge did what they meant — SongCreateForm's own comment
 * (music/songs/songs-grid.tsx) makes the identical argument for its own
 * "Song registered." — so the success state replaces the confirmation with
 * that receipt and waits for a deliberate "Done" click, rather than taking
 * the message away the instant it lands.
 */
function ConfirmMergeDialog({
  companyId,
  kind,
  survivor,
  losers,
  reason,
  onCancel,
  onFailed,
  onDone,
}: {
  companyId: string;
  kind: MusicMergeKind;
  survivor: MergeCandidate;
  losers: MergeCandidate[];
  reason: string;
  onCancel: () => void;
  /**
   * Fired the instant a submitted merge comes back refused — not only when
   * the dialog is later dismissed. Fix round 1: this dialog unmounts (taking
   * `state.message` with it) on every dismissal path, ESC and a backdrop
   * click included, not only the "Cancel" button — so the parent has to
   * learn the message the moment it exists, or it is lost no matter which
   * of those the operator uses.
   */
  onFailed: (message: string) => void;
  onDone: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(mergeRecordsAction, INITIAL_MERGE);

  useEffect(() => {
    if (state.ok === false) onFailed(state.message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={state.ok === true ? onDone : onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{state.ok === true ? t('mergeComplete') : t('mergeTheseRecords')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {state.ok === true ? (
          <p className="text-sm text-emerald-700" data-testid="maintenance-merge-result">
            {state.message}
          </p>
        ) : (
          <p className="text-sm" data-testid="maintenance-merge-confirmation-text">
            {mergeConfirmationText(kind, survivor, losers)}
          </p>
        )}
        {state.ok === false && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        {state.ok === true ? (
          <Button type="button" onClick={onDone} data-testid="maintenance-merge-done">
            {t('done')}</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('cancel')}</Button>
            <form action={action}>
              <input type="hidden" name="companyId" value={companyId} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="winnerId" value={survivor.id} />
              {losers.map((loser) => (
                <input key={loser.id} type="hidden" name="loserIds" value={loser.id} />
              ))}
              <input type="hidden" name="reason" value={reason} />
              <Button type="submit" disabled={pending} data-testid="maintenance-merge-confirm">
                {pending ? t('merging') : t('mergeAnyway')}
              </Button>
            </form>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
