import { describe, expect, it } from 'vitest';
import { nextShowSavedConfirmation } from '@/app/(app)/messages/promo/hashtag-fields';

/**
 * Fix Round 1's finding: the "Saved" confirmation was dead code on the
 * ordinary path. `touched` was set `true` on every edit and never set back to
 * `false` on a successful save, so by the time `state.status` became
 * `'saved'` the guard `!touched` was already false and the confirmation could
 * never render. Tested as a pure function rather than through the component:
 * this project's unit tests run in vitest's `node` environment with no DOM
 * (vitest.config.ts), so there is no render to assert against — the same
 * reasoning tests/unit/promotion-record-dialog.test.ts and
 * tests/unit/run-draw-dialog.test.ts give for their own shape.
 *
 * `!touched` was invisible when it was wrong: nothing failed, nothing threw,
 * an operator simply never saw the word "Saved". These cases pin the ORDER
 * that matters — edit-then-save must show it, save-then-edit must hide it —
 * which a test of the render-time `&&` alone could not have caught, since
 * that boolean logic was never the bug.
 */
describe('nextShowSavedConfirmation', () => {
  it('shows the confirmation once a save lands', () => {
    expect(nextShowSavedConfirmation(false, 'saved')).toBe(true);
  });

  it('hides the confirmation the moment a field is edited', () => {
    expect(nextShowSavedConfirmation(true, 'edited')).toBe(false);
  });

  it('stays hidden on an edit before anything has ever been saved', () => {
    expect(nextShowSavedConfirmation(false, 'edited')).toBe(false);
  });

  it('THE ORDINARY PATH: edit, then save -- must show', () => {
    let visible = false;
    visible = nextShowSavedConfirmation(visible, 'edited');
    visible = nextShowSavedConfirmation(visible, 'saved');
    expect(visible).toBe(true);
  });

  it('save, then edit again -- must hide', () => {
    let visible = false;
    visible = nextShowSavedConfirmation(visible, 'saved');
    visible = nextShowSavedConfirmation(visible, 'edited');
    expect(visible).toBe(false);
  });
});
