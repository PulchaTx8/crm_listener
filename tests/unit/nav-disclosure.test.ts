import { describe, expect, it } from 'vitest';
import {
  activeSectionKey,
  isSectionOpen,
  parseExpanded,
  serializeExpanded,
  toggleExpanded,
} from '@/lib/nav/disclosure';

const SECTIONS = [
  { key: 'overview', items: [{ href: '/app' }] },
  { key: 'inventory', items: [{ href: '/inventory' }, { href: '/inventory/movements' }] },
  { key: 'audience', items: [{ href: '/members' }, { href: '/music/requests' }] },
  { key: 'catalog', items: [{ href: '/music/songs' }, { href: '/catalog/albums' }] },
];

describe('parseExpanded', () => {
  it('reads a comma-separated list', () => {
    expect(parseExpanded('audience,catalog')).toEqual(['audience', 'catalog']);
  });

  /**
   * The default is EVERYTHING CLOSED, and it is expressed as the absence of a
   * cookie rather than as a list naming every section — so a caller who has
   * never touched the sidebar carries no state at all.
   */
  it('answers empty for a cookie that is not there', () => {
    expect(parseExpanded(undefined)).toEqual([]);
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('')).toEqual([]);
  });

  /**
   * Sections come and go between blocks. A key left over from an older
   * deployment must not break the sidebar, and neither must whitespace or an
   * empty element from a hand-edited value: this cookie is not HttpOnly.
   */
  it('drops blanks and keeps unknown keys harmlessly', () => {
    expect(parseExpanded('audience,,  ,catalog')).toEqual(['audience', 'catalog']);
    expect(parseExpanded('  audience , retired_section ')).toEqual([
      'audience',
      'retired_section',
    ]);
  });

  it('de-duplicates rather than trusting what was written', () => {
    expect(parseExpanded('audience,audience')).toEqual(['audience']);
  });
});

describe('serializeExpanded', () => {
  it('round-trips through parseExpanded', () => {
    expect(parseExpanded(serializeExpanded(['audience', 'catalog']))).toEqual([
      'audience',
      'catalog',
    ]);
  });

  it('writes an empty string for nothing expanded', () => {
    expect(serializeExpanded([])).toBe('');
  });
});

describe('activeSectionKey', () => {
  it('finds the section holding an exact match', () => {
    expect(activeSectionKey(SECTIONS, '/members')).toBe('audience');
  });

  it('finds the section holding a nested route', () => {
    expect(activeSectionKey(SECTIONS, '/members/abc-123')).toBe('audience');
  });

  /**
   * `/app` must not light up for `/app-something`. The slash is what makes the
   * prefix a path segment rather than a string prefix — the same rule the link
   * highlighting has always used.
   */
  it('does not match a route that merely starts with the same letters', () => {
    expect(activeSectionKey(SECTIONS, '/appointments')).toBeNull();
  });

  /**
   * Defensive rather than load-bearing today — no href in the real sidebar
   * carries a query string any more (Block 20c gave Catalogue's three items
   * real routes instead of the `?tab=` addresses this strip used to be
   * necessary for). The function still promises to strip one, so this pins
   * that promise with a synthetic fixture rather than a route that no longer
   * exists.
   */
  it('matches an item whose href carries a query string', () => {
    const withQuery = [{ key: 'catalog', items: [{ href: '/catalog/albums?tab=labels' }] }];
    expect(activeSectionKey(withQuery, '/catalog/albums')).toBe('catalog');
  });

  /**
   * Both of these resolve correctly under ANY tie-break rule, because
   * `/music/requests` and `/music/songs` are siblings rather than one being a
   * prefix of the other. Kept because they are the real hrefs this block moves
   * between two sections, and a regression there is what somebody would
   * actually hit — but see the case below for the rule itself.
   */
  it('files the two /music routes under the sections that own them', () => {
    expect(activeSectionKey(SECTIONS, '/music/requests')).toBe('audience');
    expect(activeSectionKey(SECTIONS, '/music/songs')).toBe('catalog');
  });

  /**
   * THE LONGEST-MATCH RULE ITSELF, and this fixture is deliberately synthetic:
   * **no two sections in the real sidebar own hrefs in a prefix relationship
   * today.** The only prefix pair that exists — `/inventory` and
   * `/inventory/movements` — sits inside ONE section, where the tie-break
   * cannot change the answer.
   *
   * So the rule is defensive, and this is what makes it testable rather than
   * decorative: without a case that can only pass under longest-match, the
   * rule could be replaced by `Array.prototype.find` and every test would stay
   * green. One nav edit is all it would take for that to start mattering.
   */
  it('prefers the longest matching href when two sections genuinely overlap', () => {
    const overlapping = [
      { key: 'wide', items: [{ href: '/music' }] },
      { key: 'narrow', items: [{ href: '/music/songs' }] },
    ];
    expect(activeSectionKey(overlapping, '/music/songs')).toBe('narrow');
    expect(activeSectionKey(overlapping, '/music/songs/123')).toBe('narrow');
    // And the wide one still wins where it is the only match.
    expect(activeSectionKey(overlapping, '/music/other')).toBe('wide');
  });

  it('answers null for a path no section names', () => {
    expect(activeSectionKey(SECTIONS, '/nowhere')).toBeNull();
  });
});

describe('isSectionOpen', () => {
  it('opens a section the caller expanded', () => {
    expect(isSectionOpen('catalog', null, ['catalog'])).toBe(true);
  });

  it('opens the active section even when the caller never expanded it', () => {
    expect(isSectionOpen('audience', 'audience', [])).toBe(true);
  });

  it('leaves everything else closed', () => {
    expect(isSectionOpen('catalog', 'audience', [])).toBe(false);
  });

  it('closes everything when there is no cookie and no active section', () => {
    expect(isSectionOpen('catalog', null, [])).toBe(false);
  });

  /**
   * Whole-branch review, I1. `collapsedKey` is the hand-collapse override for
   * the ACTIVE section — sidebar-nav.tsx used to answer this itself with a
   * ternary that bypassed this function entirely for the section the caller is
   * standing in, so the rule that took two review rounds to settle (first it
   * wrote the opposite preference into the cookie; then it revived on a round
   * trip) was reachable only by a browser. These three cases pin it here.
   */
  describe('the active-section override', () => {
    it('closes only its own section', () => {
      expect(isSectionOpen('audience', 'audience', [], 'audience')).toBe(false);
    });

    it('never closes a section that is not the active one, even if it shares the override key', () => {
      // 'catalog' is expanded via the cookie and is NOT the active section here
      // ('audience' is) — the override answers only for the section named by
      // `activeKey`, so a stray or coincidental match on `collapsedKey` must not
      // reach into a different section's answer.
      expect(isSectionOpen('catalog', 'audience', ['catalog'], 'catalog')).toBe(true);
    });

    it('reopens once the override is cleared', () => {
      expect(isSectionOpen('audience', 'audience', [], null)).toBe(true);
    });
  });
});

describe('toggleExpanded', () => {
  it('adds a key that is absent', () => {
    expect(toggleExpanded(['audience'], 'catalog')).toEqual(['audience', 'catalog']);
  });

  it('removes a key that is present', () => {
    expect(toggleExpanded(['audience', 'catalog'], 'audience')).toEqual(['catalog']);
  });

  /**
   * The caller (sidebar-nav.tsx) re-renders from `expanded`, comparing it to
   * what was on screen before — a function that mutated its input in place
   * would corrupt that comparison, and this is the case that would only fail
   * quietly, in the browser, on the second click.
   */
  it('does not mutate its input', () => {
    const before = ['audience'];
    const snapshot = [...before];
    toggleExpanded(before, 'catalog');
    expect(before).toEqual(snapshot);
  });
});
