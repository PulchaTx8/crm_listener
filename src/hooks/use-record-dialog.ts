'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRecordParam, withRecord } from '@/lib/record-params';

/**
 * Owns which record is open and which tab, and keeps the URL in step WITHOUT a
 * server round trip.
 *
 * This is the block's central mechanism, so it is worth being explicit about
 * why it is written against the raw history API. `useRouter().push('?record=x')`
 * asks Next for a fresh render of this route — which re-runs the list's keyset
 * query, rebuilds the grid and throws away the operator's place in it. The
 * native history API changes the address bar and nothing else, which is the
 * whole requirement: the record opens OVER a list that never moves.
 *
 * The price of that choice, stated so nobody trips over it later: `useSearchParams()`
 * does not observe these writes. Nothing may read the open record from there.
 * While this page is mounted, this hook's state is the single source of truth;
 * the parsed URL is the source only for the first render.
 */
export function useRecordDialog(
  tabs: readonly string[],
  initial: { recordId: string | null; tab: string | null },
) {
  const [recordId, setRecordId] = useState(initial.recordId);
  const [tab, setTabState] = useState(initial.tab ?? tabs[0] ?? null);

  /**
   * Whether the entry the browser is showing right now is one open() pushed —
   * which is to say, whether closing has an entry OF ITS OWN to step back off.
   * See close() for why the record being in the URL is not the same question,
   * and for why "pop" is the wrong word: back() moves the traversal pointer and
   * leaves the entry standing.
   *
   * Deliberately pessimistic: it goes false on every popstate, because the
   * event says the pointer moved and not where it moved to, and there is no
   * way to ask the browser whether the entry it landed on came from this hook.
   * Being wrong in this direction costs an extra history entry; being wrong in
   * the other direction navigates the operator off the page, which is the
   * defect this ref exists to end. Marking our entries in history.state would
   * answer the question exactly rather than pessimistically, and was rejected:
   * that object belongs to the Next app router, which patches pushState to copy
   * __NA and its own route tree into whatever we pass and reads them back on
   * every popstate. A second writer in there ties this hook to the shape of
   * fields Next names private.
   */
  const ownsCurrentEntry = useRef(false);

  // Back and Forward. The browser has already rewritten the URL by the time
  // this fires, so the URL is what the state reconciles against.
  useEffect(() => {
    function onPopState() {
      ownsCurrentEntry.current = false;
      const raw = Object.fromEntries(new URLSearchParams(window.location.search));
      const next = parseRecordParam(raw, tabs);
      setRecordId(next.recordId);
      setTabState(next.tab ?? tabs[0] ?? null);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [tabs]);

  const currentSearch = () => window.location.search.replace(/^\?/, '');
  const addressFor = (search: string) => (search ? `?${search}` : window.location.pathname);

  const open = useCallback(
    (id: string, nextTab?: string) => {
      const chosen = nextTab && tabs.includes(nextTab) ? nextTab : (tabs[0] ?? null);
      setRecordId(id);
      setTabState(chosen);
      const search = withRecord(currentSearch(), id, chosen);
      window.history.pushState(null, '', addressFor(search));
      ownsCurrentEntry.current = true;
    },
    [tabs],
  );

  /**
   * replaceState, not pushState: otherwise Back walks backwards through every
   * tab the operator visited instead of closing the record, which is what Back
   * means while a dialog is open.
   */
  const setTab = useCallback((nextTab: string) => {
    setTabState(nextTab);
    const id = new URLSearchParams(window.location.search).get('record');
    if (!id) return;
    const search = withRecord(currentSearch(), id, nextTab);
    window.history.replaceState(null, '', addressFor(search));
  }, []);

  /**
   * Closing takes the record out of the address without leaving this page, and
   * which instrument does that depends on who put the record in the address.
   *
   * After open() there is an entry of ours on the stack, and history.back()
   * steps the pointer off exactly it: the address returns to the list the
   * operator was already looking at, and the stack does not grow — it does not
   * POP the entry, which is the correction the last paragraph of this comment
   * makes at length. Pushing the closed URL instead
   * would leave the record one Back away, so Back would walk backwards through
   * every record opened on this page rather than leaving the list — which is
   * what Back means while a dialog is open.
   *
   * When the record arrived any other way — a pasted link, a bookmark, the
   * first address of the session — there is no entry of ours behind us, and back()
   * walks the operator off the page: a full document navigation to whatever
   * preceded this one. replaceState overwrites the address in place instead.
   * Nothing navigates, no entry is added, and the record is left neither behind
   * the pointer nor ahead of it. It is the instrument setTab already uses on
   * this hook's own writes, and record-dialog.spec.ts already measures it as
   * costing no render of the list.
   *
   * The guard this replaces asked whether the record IS in the URL. That is
   * true in both cases, so it could not tell them apart, and the accident its
   * own comment named — "closing something that was never addressed there would
   * walk the operator off the page" — is precisely what happened, on the one
   * input the guard could not see. Every screen paid for it: an operator who
   * closed a record opened from a pasted link had the page reloaded under them,
   * and whatever they did in the second before it landed was thrown away. What
   * that looked like from a desk is in members-flow.spec.ts — a registration
   * dialog that opened and then closed itself.
   *
   * One correction to the old comment, since its sentence has been read as the
   * requirement: it said back() was chosen so that closing "does not leave a
   * forward-stack entry that re-opens the record on Forward". It is the other
   * way round. back() moves the pointer to before the record's entry, so the
   * record IS the entry ahead, and Forward re-opens it — measured on this hook
   * before this change, and the layout promotions-flow.spec.ts already
   * describes. Pushing the closed URL is what would leave nothing ahead, by
   * clearing the stack. back() is still right on the branch it guards, for the
   * Back reason above; only the reason given was wrong.
   *
   * Neither branch reaches for useRouter().push. See this file's doc comment:
   * that is the one move that would re-run the list's keyset query, which is
   * the whole thing this hook exists to avoid.
   *
   * A RELATED HAZARD, FOUND RATHER THAN FIXED HERE. history.back() fires a
   * popstate that Next's App Router answers with a background RSC fetch of
   * its own for the bare URL closing lands on. A record read dispatched by
   * open() while that fetch is still in flight — closing one record and
   * reopening another quickly enough — can be silently dropped rather than
   * merely delayed: traced with request/response logging
   * (promotion-rules-gate.spec.ts), the dropped case never shows a second
   * request for the read at all, which is what tells it apart from slow.
   * What an operator sees is a record dialog stuck on "Loading…", reached by
   * closing a record and reopening one quickly, with whatever they had just
   * saved already sitting in the database behind it.
   *
   * The same class of hazard src/services/promotions.ts:630-646 names for a
   * different pair of actions on this same dialog — a server action
   * dispatched from an effect that can race a Save in flight — and there the
   * resolution was to remove the window rather than narrow it, reading the
   * participation counts with the record instead of fetching them on mount.
   * That fix does not generalise here: thirteen screens close their records
   * through this hook today (`grep -rln '= useRecordDialog(' src/app` —
   * re-run it rather than trust this count, which is only as current as the
   * day this paragraph was written) — Members, Promotions, Songs, Programmes,
   * Inventory, Team and Roles among them — so changing how close() talks to
   * the router is a change to all of them at once, each needing its own
   * journey to show the change did not break the one thing this hook exists
   * to guarantee: a list that never re-renders when a record opens. That is a
   * block of its own, not a line changed in passing here. (Participations,
   * Pickups and Requests do NOT use this hook — their record dialogs are
   * plain local state — so they do not carry this
   * particular hazard.)
   */
  const close = useCallback(() => {
    setRecordId(null);
    // Cleared before the early return, not inside the branch below: no record in
    // the address means no entry of ours under the pointer, so the invariant
    // "this ref is false whenever the record is closed" holds unconditionally
    // rather than by an argument about which paths can reach which line.
    const owned = ownsCurrentEntry.current;
    ownsCurrentEntry.current = false;
    if (!new URLSearchParams(window.location.search).has('record')) return;
    if (owned) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', addressFor(withRecord(currentSearch(), null, null)));
  }, []);

  return { recordId, tab, open, setTab, close };
}
