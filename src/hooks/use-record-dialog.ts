'use client';

import { useCallback, useEffect, useState } from 'react';
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

  // Back and Forward. The browser has already rewritten the URL by the time
  // this fires, so the URL is what the state reconciles against.
  useEffect(() => {
    function onPopState() {
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
   * history.back() rather than pushing the closed URL, so closing does not
   * leave a forward-stack entry that re-opens the record on Forward. Guarded on
   * the record actually being in the URL: closing something that was never
   * addressed there would walk the operator off the page.
   */
  const close = useCallback(() => {
    setRecordId(null);
    if (new URLSearchParams(window.location.search).has('record')) window.history.back();
  }, []);

  return { recordId, tab, open, setTab, close };
}
