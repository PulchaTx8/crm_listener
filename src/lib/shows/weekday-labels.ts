/**
 * The catalogue key that names each ISO weekday, in one place.
 *
 * Two screens render the days of a schedule — the band editor (Block 18) and the
 * week grid (Block 30e) — and both must call Monday the same thing. A second map
 * would be a second set of day names, free to drift, and drifting day names on a
 * schedule are the kind of defect that reads as a rendering quirk rather than as
 * a bug.
 */
export const WEEKDAY_LABEL_KEYS: Record<number, string> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
  7: 'sunday',
};
