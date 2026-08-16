import { describe, expect, it } from 'vitest';
import { NAV_COLLAPSED_COOKIE, NAV_COLLAPSED_MAX_AGE, parseCollapsed } from '@/lib/nav/collapse';

/**
 * Block 27. The cookie is writable by the page — the client sets it on every
 * click so folding costs no round trip — so everything here is hostile input,
 * and every unreadable shape means "expanded".
 *
 * THE TWO FAILURE MODES ARE NOT SYMMETRIC, which is the whole reason the default
 * is what it is: a sidebar that wrongly arrives EXPANDED costs one click, and
 * one that wrongly arrives FOLDED hides every label on a screen the caller may
 * not know their way around.
 *
 * In its own file rather than inside sidebar-nav.tsx, on disclosure.ts's
 * standing reason: the sidebar is a client component and this repository has no
 * component-testing library — vitest runs in `node`, with no jsdom and no React
 * Testing Library — so a decision left in the component is checked by a browser
 * or by nothing.
 */
describe('parseCollapsed', () => {
  it('is expanded when nothing was ever set', () => {
    expect(parseCollapsed(undefined)).toBe(false);
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed('')).toBe(false);
  });

  it('is collapsed only for the one value that means it', () => {
    expect(parseCollapsed('1')).toBe(true);
    expect(parseCollapsed('0')).toBe(false);
  });

  it('treats anything else as expanded rather than guessing', () => {
    expect(parseCollapsed('true')).toBe(false);
    expect(parseCollapsed('yes')).toBe(false);
    expect(parseCollapsed(' 1 ')).toBe(false);
    expect(parseCollapsed('1; drop table')).toBe(false);
  });
});

describe('the cookie itself', () => {
  it('is its own name, not the disclosure cookie', () => {
    // Folding and "which sections are open" are different questions: expanding
    // the rail must restore exactly what was open before, which is easiest to
    // keep true when the two never share a value.
    expect(NAV_COLLAPSED_COOKIE).toBe('pulchatx_nav_collapsed');
  });

  it('lasts a year, because a preference that expires is one nobody set', () => {
    expect(NAV_COLLAPSED_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });
});
