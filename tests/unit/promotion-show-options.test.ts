import { describe, expect, it } from 'vitest';
import { resolveShowOptions } from '@/app/(app)/promotions/promotion-fields';

/**
 * Final review, Critical #1. `promotion-fields.tsx`'s comment on
 * `resolveShowOptions` explains why this is a pure function rather than
 * something asserted through a render: this project's unit tests run in
 * vitest's `node` environment with no DOM, the same reason
 * `promotion-record-dialog.test.ts` gives for testing `nextRecordAfterFailedRead`
 * as a function rather than a component.
 *
 * The chain this closes: a member holding promotions.edit without
 * music.view gets `shows: []` from `listShowOptions`
 * (shows_select_music_view, 0099:55-57), so the combobox's `defaultValue`
 * used to name an option that did not exist among its children. A native
 * `<select>` in that shape is not undefined behaviour to guess at — the
 * browser deterministically selects its FIRST option, "No programme" — and
 * posting that on a save about something else entirely nulled `show_id`
 * through `update_promotion`'s wholesale replace (0259:320). What follows
 * proves the option list this function hands the combobox always contains
 * something matching `record.showId`, so that fallback is never reached.
 */
describe('resolveShowOptions', () => {
  it('lists every visible Programme, unchanged, when the linked one is among them', () => {
    const shows = [
      { id: 'show-1', name: 'Manhã Total' },
      { id: 'show-2', name: 'Tarde Livre' },
    ];
    const record = { showId: 'show-1', showName: 'Manhã Total' };

    expect(resolveShowOptions(shows, record, 'fallback')).toEqual([
      { id: 'show-1', label: 'Manhã Total' },
      { id: 'show-2', label: 'Tarde Livre' },
    ]);
  });

  it('lists every visible Programme, unchanged, when nothing is linked', () => {
    const shows = [{ id: 'show-1', name: 'Manhã Total' }];

    expect(resolveShowOptions(shows, null, 'fallback')).toEqual([
      { id: 'show-1', label: 'Manhã Total' },
    ]);
    expect(
      resolveShowOptions(shows, { showId: null, showName: null }, 'fallback'),
    ).toEqual([{ id: 'show-1', label: 'Manhã Total' }]);
  });

  it('appends the linked Programme, named, when it is missing from an otherwise non-empty list', () => {
    // The shape a caller WITH music.view sees for a Programme `listShowOptions`
    // no longer offers as a fresh choice (ended, say) but which this
    // promotion still legitimately points at.
    const shows = [{ id: 'show-2', name: 'Tarde Livre' }];
    const record = { showId: 'show-1', showName: 'Manhã Total (encerrado)' };

    expect(resolveShowOptions(shows, record, 'fallback')).toEqual([
      { id: 'show-2', label: 'Tarde Livre' },
      { id: 'show-1', label: 'Manhã Total (encerrado)' },
    ]);
  });

  it('appends the linked Programme under the fallback label when the caller cannot read Programmes at all', () => {
    // The C1 case itself: promotions.edit without music.view.
    // shows_select_music_view (0099:55-57) empties BOTH the option list and
    // the `shows(name, deleted_at)` embed getPromotionRecord reads showName
    // through, so showName is null here for the identical reason shows is
    // empty -- not two unrelated facts.
    const record = { showId: 'show-1', showName: null };

    expect(resolveShowOptions([], record, 'this operator cannot see Programmes')).toEqual([
      { id: 'show-1', label: 'this operator cannot see Programmes' },
    ]);
  });

  it('never duplicates the linked Programme when it is already present', () => {
    const shows = [
      { id: 'show-1', name: 'Manhã Total' },
      { id: 'show-2', name: 'Tarde Livre' },
    ];
    const record = { showId: 'show-2', showName: 'Tarde Livre' };

    const options = resolveShowOptions(shows, record, 'fallback');
    expect(options).toHaveLength(2);
    expect(options.filter((option) => option.id === 'show-2')).toHaveLength(1);
  });
});
