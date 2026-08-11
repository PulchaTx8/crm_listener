'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { ReferenceSummary } from '@/services/music';
import { ReferencePanel } from './reference-panel';

/**
 * The Catalog screen's own tab vocabulary — deliberately NOT added to
 * src/lib/record-params.ts. That module owns the address of an OPEN RECORD
 * (`?record=&tab=`), and nothing on this screen opens a record: each row is
 * its own one-field form, edited and archived in place (see
 * reference-panel.tsx). `tab=` here picks which of three short lists is
 * showing — a different question with a different owner, this file, the one
 * 'use client' module that renders it.
 *
 * `CatalogTab` is duplicated as a literal three-string array in page.tsx
 * rather than imported from here as a value: page.tsx is a Server Component,
 * and importing a runtime value out of a 'use client' module from a Server
 * Component is exactly the defect record-params.ts's own header documents at
 * length — the array would arrive as an opaque client reference, not the
 * array, and both reads a validator makes off it (`.includes`, `[0]`) answer
 * `undefined` without ever throwing. page.tsx imports this file's
 * `CatalogTab` TYPE instead (erased at compile time, so it never crosses that
 * boundary) and keeps its own three-element array for the one runtime check
 * it needs — validating `?tab=` before this component ever mounts. The two
 * arrays cannot silently drift apart: both are checked against the same
 * union, so renaming a tab in one file without the other is a type error, not
 * a quiet bug.
 */
// Block 18 took  out of this list. A programme stopped being a name in
// a reference tab and became a record with a presenter, a schedule and a run of
// dates, on its own screen under Audiência. The SHOW kind still exists in 0100
// and merge_shows still works -- what left is this screen's claim to it.
export const CATALOG_TABS = ['labels', 'genres', 'albums'] as const;
export type CatalogTab = (typeof CATALOG_TABS)[number];

// `noun` stays a bare English word because its only remaining use is a
// `data-testid`; every word a person reads is a catalogue key beside it.
const TAB_COPY: Record<
  CatalogTab,
  { labelKey: string; noun: string; descriptionKey: string }
> = {
  labels: {
    labelKey: 'tabLabels',
    noun: 'label',
    descriptionKey: 'referenceLabelsDescription',
  },
  genres: {
    labelKey: 'tabGenres',
    noun: 'genre',
    descriptionKey: 'referenceGenresDescription',
  },
  // Block 13a. An album is not one of 0100's four reference kinds — it has a
  // UPC, a cover hash and a Deezer id of its own (0136) — but on THIS screen
  // it is the same thing they are: a list of names, renamed and archived in
  // place. The tab is here so a name Deezer supplied is not permanent, since
  // the register path is the only other way an album is ever created.
  albums: {
    labelKey: 'albums',
    noun: 'album',
    descriptionKey: 'referenceAlbumsDescription',
  },
};

const KIND_FOR_TAB = { labels: 'LABEL', genres: 'GENRE', albums: 'ALBUM' } as const;

/**
 * Holds the two reference panels and the albums panel, and the tab that picks
 * which one shows. It held a third reference panel until Block 18 moved
 * programmes to a screen of their own.
 *
 * The tab lives in the URL, not only in this component's state — but never
 * through `useRouter().push`, for the reason src/hooks/use-record-dialog.ts's
 * header gives at length for the identical choice on a record's address: a
 * push asks Next for a fresh render of this route, which would re-run
 * page.tsx's three list reads for nothing a tab switch needs.
 * `history.replaceState` changes the address bar and nothing else, which is
 * exactly what flipping a tab is — and `replaceState`, not `pushState`,
 * because switching tabs is not a place Back should stop (the same
 * reasoning useRecordDialog's own `setTab` gives).
 *
 * `initialTab` arrives already validated: page.tsx parsed and clamped
 * `?tab=` before this component ever mounted, the same contract
 * parseRecordParam (record-params.ts) carries for hostile input, applied to
 * one more parameter — an unknown or missing `tab=` falls back to the first
 * tab rather than rendering nothing. This component does not re-validate it;
 * it only keeps the address bar in step with local `tab` state from here on,
 * and, once on mount, rewrites the URL to that canonical value — so a
 * bookmarked `?tab=nonsense` and a bare URL with no `tab=` at all both settle
 * on an address that means what it shows, and a link to "the genres of this
 * Station" survives a reload.
 *
 * `companyId` and any Station search already sit in the URL by the time this
 * mounts (page.tsx put them there, or a Link/StationSearchForm did on the way
 * in) and this component's own history writes only ever touch the `tab` key
 * on the CURRENT query string — never rebuild it from scratch — so switching
 * tabs cannot drop either one, unlike a hand-rolled Link would risk.
 */
export function ReferenceTabs({
  companyId,
  manage,
  initialTab,
  labels,
  genres,
  albums,
}: {
  companyId: string;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; create_music_reference/update_music_reference/archive_music_reference each re-check it themselves. */
  manage: boolean;
  initialTab: CatalogTab;
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  albums: ReferenceSummary[];
}) {
  const t = useTranslations('music');
  const [tab, setTabState] = useState<CatalogTab>(initialTab);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set('tab', initialTab);
    const search = query.toString();
    window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
    // initialTab is this mount's canonical value, computed once by page.tsx;
    // every later change goes through setTab below instead of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTab(next: CatalogTab) {
    setTabState(next);
    const query = new URLSearchParams(window.location.search);
    query.set('tab', next);
    const search = query.toString();
    window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
  }

  const itemsByTab: Record<CatalogTab, ReferenceSummary[]> = { labels, genres, albums };

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={t('catalogueLists')} className="flex gap-1 border-b">
        {CATALOG_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={
              tab === name
                ? 'border-b-2 border-primary px-4 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-4 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
            data-testid={`catalog-tab-${name}`}
          >
            {t(TAB_COPY[name].labelKey)}
          </button>
        ))}
      </div>

      {/* Keyed on the tab: a clean remount between panels means no leftover
          per-row action state (an unsaved edit, a stale error) from one
          panel's rows bleeds into another's after a switch. */}
      <ReferencePanel
        key={tab}
        kind={KIND_FOR_TAB[tab]}
        noun={TAB_COPY[tab].noun}
        title={t(TAB_COPY[tab].labelKey)}
        description={t(TAB_COPY[tab].descriptionKey)}
        items={itemsByTab[tab]}
        companyId={companyId}
        manage={manage}
      />
    </div>
  );
}
