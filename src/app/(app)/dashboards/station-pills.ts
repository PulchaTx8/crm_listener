/**
 * What each Station pill in "Stations shown" does when it is clicked.
 *
 * The dashboards used to carry TWO rows of Station names: a switcher whose pills
 * REPLACED the selection, and this control's pills, which ADD and REMOVE. One row
 * of names is now all there is, so a single pill has to be able to mean either —
 * and which one it means is a permission question, not a styling one.
 *
 * Pulled out of the component for the reason place-map-geometry.ts sets out for
 * its own two formulas: this project installs no jsdom, and what needs proving
 * here is not that a row of links mounts. It is that no pill can build a URL the
 * RPC refuses. There are exactly two of those URLs — the empty selection, which
 * 0118 raises 22023 for, and a selection naming a Station outside
 * `reports.consolidated`, which it refuses with 42501 — and both are reachable
 * from an ordinary click unless something forbids them here.
 */

export type StationPillMode =
  /** Adds this Station to the selection, or takes it back out. */
  | 'toggle'
  /** Replaces the whole selection with this Station alone. */
  | 'replace';

export interface StationPill {
  id: string;
  mode: StationPillMode;
  /** Whether this Station's figures are among the ones on the screen. */
  selected: boolean;
  /** The ids this pill's link navigates to. Never empty. */
  next: string[];
}

/**
 * Whether an "All stations" chip has anything to link to.
 *
 * With one consolidable Station the chip would be a second pill for that Station
 * wearing a label claiming more than it delivers; with none it would link to an
 * empty array.
 */
export function canSelectAll(consolidatedIds: string[]): boolean {
  return consolidatedIds.length >= 2;
}

export function stationPills({
  stations,
  consolidatedIds,
  selectedIds,
  fallbackId,
}: {
  /** Every Station the caller can view, in the order they should be read. */
  stations: { id: string }[];
  /** Of those, the ones `reports.consolidated` reaches. */
  consolidatedIds: string[];
  /** The selection the page actually resolved and read the panel with. */
  selectedIds: string[];
  /** Where emptying the selection goes instead — the caller's own Station. */
  fallbackId: string;
}): StationPill[] {
  const consolidated = new Set(consolidatedIds);
  const selected = new Set(selectedIds);

  // ONE CONSOLIDABLE STATION IS NOT A SET, so nothing on this row toggles: the
  // only eligible pill could then only ever be turned OFF, and off is the empty
  // selection. Every pill does what the old switcher row did, which is also
  // exactly what this caller had before the two rows became one.
  const multi = canSelectAll(consolidatedIds);

  // The selection as the RPC would accept it. A caller sitting on a Station
  // outside reports.consolidated has a legal single-Station view; appending to
  // it would turn a legal URL into a 42501, so a toggle builds from this rather
  // than from `selectedIds` raw.
  const base = selectedIds.filter((id) => consolidated.has(id));

  return stations.map((station) => {
    const isSelected = selected.has(station.id);
    if (!multi || !consolidated.has(station.id)) {
      return { id: station.id, mode: 'replace', selected: isSelected, next: [station.id] };
    }

    const next = isSelected
      ? base.filter((id) => id !== station.id)
      : [...base.filter((id) => id !== station.id), station.id];

    return {
      id: station.id,
      mode: 'toggle',
      selected: isSelected,
      // The fallback is the caller's Station and NOT this pill's own id:
      // turning the last pill off must never read as turning it on.
      next: next.length > 0 ? next : [fallbackId],
    };
  });
}
