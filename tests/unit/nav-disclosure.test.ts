import { describe, expect, it } from 'vitest';
import {
  activeSectionKey,
  isSectionOpen,
  parseExpanded,
  serializeExpanded,
} from '@/lib/nav/disclosure';

const SECTIONS = [
  { key: 'overview', items: [{ href: '/app' }] },
  { key: 'inventory', items: [{ href: '/inventory' }, { href: '/inventory/movements' }] },
  { key: 'audience', items: [{ href: '/members' }, { href: '/music/requests' }] },
  { key: 'catalog', items: [{ href: '/music/songs' }, { href: '/music/catalog?tab=labels' }] },
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
   * The query string is where Block 20b's three catalogue items differ from
   * each other, and it is not part of a pathname. Matching must ignore it, or
   * the catalogue section is never active.
   */
  it('matches an item whose href carries a query string', () => {
    expect(activeSectionKey(SECTIONS, '/music/catalog')).toBe('catalog');
  });

  /**
   * `/music/requests` is Audience's and `/music/songs` is Catalogue's. A naive
   * first-match over a shared prefix would put the listener in the wrong
   * section; the longest matching href wins.
   */
  it('prefers the longest matching href when two sections share a prefix', () => {
    expect(activeSectionKey(SECTIONS, '/music/requests')).toBe('audience');
    expect(activeSectionKey(SECTIONS, '/music/songs')).toBe('catalog');
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
});
