import { describe, expect, it } from 'vitest';
import { startsAnotherNavigation } from '@/app/(app)/participations/participations-filters';
import type { ClickIntent } from '@/app/(app)/participations/participations-filters';

/**
 * The decision behind the guard that cancels a pending debounced search when
 * the operator starts a navigation.
 *
 * Task 9 found that the previous guard — an effect keyed on the address the
 * server rendered — could only fire once the destination had COMMITTED, which
 * on this screen is several sequential Supabase round trips. Against a 350ms
 * debounce it lost: driven six times per case in a production build, a Station
 * chip held 5 of 6 and a page turn 0 of 6, so typing and then turning the page
 * threw the page turn away and applied the search the operator had abandoned.
 * The fix cancels when the navigation is STARTED. The end-to-end proof is
 * tests/e2e/participations-flow.spec.ts's Station-chip journey.
 *
 * What that journey cannot reach is the other direction, and it is the one that
 * matters here: a cancel is DESTRUCTIVE. It throws away a search the operator
 * is in the middle of typing. So every `false` below is a refusal to do damage,
 * and each is tested on its own, because a listener that answers "yes" too
 * readily is not a smaller version of the defect it was written for — it is a
 * new one, and it would be invisible in a journey that only ever clicks real
 * links.
 *
 * Tested as a pure function rather than through the component: this project's
 * unit tests run in vitest's `node` environment with no DOM (vitest.config.ts),
 * so there is no render to dispatch a click into. The same reason, and the same
 * shape, as tests/unit/promotion-record-dialog.test.ts's own header. What is
 * left in the component is the two lines that need a DOM — `closest('a[href]')`
 * and reading `.href`/`.target` off the anchor.
 */

const HERE = 'http://localhost:3000/participations?companyId=abc';

/** A plain primary click on an in-app link going somewhere else: the one case that cancels. */
function navigatingClick(overrides: Partial<ClickIntent> = {}): ClickIntent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    href: 'http://localhost:3000/participations?companyId=xyz',
    target: '',
    ...overrides,
  };
}

describe('startsAnotherNavigation', () => {
  it('cancels for a plain click on a link to another address in the app', () => {
    expect(startsAnotherNavigation(navigatingClick(), HERE)).toBe(true);
  });

  it('cancels for a page turn, which differs only in the cursor', () => {
    const intent = navigatingClick({
      href: 'http://localhost:3000/participations?companyId=abc&after=eyJ2YWx1ZSI6',
    });
    // The case that held 0 of 6 before the fix. It differs from the current
    // address in one parameter, which is exactly why the address the old guard
    // compared had to carry the cursor — and why this one has to treat it as a
    // real destination rather than as the page we are already on.
    expect(startsAnotherNavigation(intent, HERE)).toBe(true);
  });

  it('cancels for a link to a different route entirely', () => {
    expect(
      startsAnotherNavigation(navigatingClick({ href: 'http://localhost:3000/promotions' }), HERE),
    ).toBe(true);
  });

  describe('the five refusals — each one protects a search in flight', () => {
    it('refuses a non-primary click, which opens a context menu rather than navigating', () => {
      expect(startsAnotherNavigation(navigatingClick({ button: 2 }), HERE)).toBe(false);
      expect(startsAnotherNavigation(navigatingClick({ button: 1 }), HERE)).toBe(false);
    });

    it.each([['metaKey'], ['ctrlKey'], ['shiftKey'], ['altKey']] as const)(
      'refuses a %s-modified click, which opens a tab or window and leaves this document where it is',
      (modifier) => {
        expect(startsAnotherNavigation(navigatingClick({ [modifier]: true }), HERE)).toBe(false);
      },
    );

    it('refuses a click that was not inside an anchor at all', () => {
      // Everything else about it is a navigation; only the anchor is missing.
      // This is the ordinary case — most clicks on this screen are on the
      // filter controls, and none of them may cost the operator their search.
      expect(startsAnotherNavigation(navigatingClick({ href: null }), HERE)).toBe(false);
    });

    it('refuses a link aimed somewhere other than this document', () => {
      expect(startsAnotherNavigation(navigatingClick({ target: '_blank' }), HERE)).toBe(false);
      expect(startsAnotherNavigation(navigatingClick({ target: 'a-named-frame' }), HERE)).toBe(
        false,
      );
    });

    it('accepts the three targets that DO navigate this document', () => {
      // `_top` and `_parent` are `_self` in an app that is never framed, and
      // treating them as elsewhere would have been a missed cancel — the defect
      // this guard exists to prevent, in a rarer spelling.
      for (const target of ['', '_self', '_top', '_parent']) {
        expect(startsAnotherNavigation(navigatingClick({ target }), HERE), target).toBe(true);
      }
    });

    it('refuses a cross-origin link', () => {
      expect(
        startsAnotherNavigation(navigatingClick({ href: 'https://example.test/help' }), HERE),
      ).toBe(false);
    });

    it('refuses a link to the address we are already at, which undoes nothing', () => {
      expect(startsAnotherNavigation(navigatingClick({ href: HERE }), HERE)).toBe(false);
    });

    it('refuses an unparseable href rather than throwing into a click handler', () => {
      // A relative href resolves against the current address, so this is about
      // genuinely malformed input; the listener runs on EVERY click in the
      // document, and a throw here would be a broken page rather than a lost
      // search.
      expect(startsAnotherNavigation(navigatingClick({ href: 'http://[' }), HERE)).toBe(false);
    });
  });

  it('resolves a relative href against the address it is given', () => {
    // The component passes `anchor.href`, which the DOM has already resolved,
    // but the function must not depend on that being true of its caller.
    expect(
      startsAnotherNavigation(navigatingClick({ href: '/participations?companyId=xyz' }), HERE),
    ).toBe(true);
    expect(
      startsAnotherNavigation(navigatingClick({ href: '/participations?companyId=abc' }), HERE),
    ).toBe(false);
  });
});
