import { describe, expect, it } from 'vitest';
import {
  colour,
  contrast,
  indexOfRule,
  over,
  ruleBody,
  tokensIn,
  token,
} from './colour';

/**
 * Block 25, D3. What makes it safe for the dark palette to exist twice.
 *
 * The tokens have to apply under `.dark` (the person chose) AND under
 * `@media (prefers-color-scheme: dark) { :root:not(.light) }` (the person chose
 * System, which is the absence of a class). CSS cannot put a media query inside
 * a selector list, so there is no way to write the block once — and the
 * alternative, declaring the values as `--d-*` on `:root` and re-pointing from
 * two thin blocks, trades one duplication for an indirection that doubles the
 * custom properties on `:root` and STILL duplicates the mapping.
 *
 * So the block is duplicated and this file is the thing that makes drift
 * impossible rather than unlikely.
 */

/** The system-dark block: the rule inside the media query, reached by name. */
function systemDarkBody(): string {
  const media = indexOfRule('@media (prefers-color-scheme: dark)');
  return ruleBody(':root:not(.light)', media);
}

describe('the dark palette, which exists twice', () => {
  it('declares the same tokens in both places', () => {
    const chosen = [...tokensIn(ruleBody('.dark')).keys()].sort();
    const system = [...tokensIn(systemDarkBody()).keys()].sort();
    expect(system).toEqual(chosen);
  });

  it('gives every one of them the same value in both places', () => {
    const chosen = tokensIn(ruleBody('.dark'));
    const system = tokensIn(systemDarkBody());
    for (const [name, value] of chosen) {
      expect(system.get(name), `--${name}`).toBe(value);
    }
  });

  /**
   * `color-scheme` is not a custom property, so the two assertions above cannot
   * see it — and it is the one declaration in these blocks that no token work
   * would substitute for: it is what makes the browser's own form controls,
   * scrollbars and autofill follow the theme.
   */
  it('sets color-scheme in both places, and light on :root', () => {
    expect(ruleBody('.dark')).toMatch(/color-scheme:\s*dark;/);
    expect(systemDarkBody()).toMatch(/color-scheme:\s*dark;/);
    expect(ruleBody(':root')).toMatch(/color-scheme:\s*light;/);
  });
});

/**
 * THE ASSERTION THAT CATCHES A FIFTH TOKEN ADDED TO ONE PALETTE ONLY.
 *
 * The two tests above hold the two DARK blocks together; this one holds dark to
 * light. Without it, a token added to `:root` alone renders its light value on a
 * dark page — which is exactly how `--success` would have been half-shipped.
 */
describe('light and dark are the same vocabulary', () => {
  /**
   * Tokens that are NOT colours, and therefore have nothing to say about a
   * theme. A named list rather than a pattern: `--radius` is a corner, it is the
   * same corner in both themes, and the next non-colour token has to be added
   * here deliberately rather than slipping past a regex somebody wrote to make
   * this test go green.
   */
  const GEOMETRY = new Set(['radius']);

  it('gives every :root colour token a dark counterpart', () => {
    const light = [...tokensIn(ruleBody(':root')).keys()].filter((name) => !GEOMETRY.has(name));
    const dark = tokensIn(ruleBody('.dark'));
    const missing = light.filter((name) => !dark.has(name));
    expect(missing, 'declared in :root and not in .dark').toEqual([]);
  });

  it('does not redeclare geometry in the dark palette', () => {
    const dark = tokensIn(ruleBody('.dark'));
    for (const name of GEOMETRY) {
      expect(dark.has(name), `--${name} is not a colour and belongs in :root alone`).toBe(false);
    }
  });
});

/**
 * The two new semantic colours (D9), measured rather than eyeballed.
 *
 * THE `/10` SURFACE IS THE ONE THAT ALMOST SHIPPED WRONG. A badge is
 * `bg-success/10 text-success` — the token painted at a tenth over the page,
 * with the solid token as its text — so the number that matters is the token
 * against its own tint, not against the page. The first amber chosen for
 * `--warning` measured 4.83 on the page and 4.22 there, and 4.22 is a fail.
 *
 * 4.5 is the floor, and it is the floor the existing `--destructive` already
 * clears on the same surface (4.74) — this is the house's own ruler, not a new
 * one invented for these two.
 */
describe('success and warning are legible in both themes', () => {
  const cases = [
    { theme: ':root', page: ':root' },
    { theme: '.dark', page: '.dark' },
  ] as const;

  for (const family of ['success', 'warning'] as const) {
    for (const { theme, page } of cases) {
      it(`--${family} reads against the ${theme} page`, () => {
        expect(contrast(colour(theme, family), colour(page, 'background'))).toBeGreaterThanOrEqual(
          4.5,
        );
      });

      it(`--${family} reads against its own /10 badge surface in ${theme}`, () => {
        const solid = colour(theme, family);
        const surface = over(solid, colour(page, 'background'), 0.1);
        expect(contrast(solid, surface)).toBeGreaterThanOrEqual(4.5);
      });

      it(`--${family}-foreground reads on a solid ${family} fill in ${theme}`, () => {
        expect(
          contrast(colour(theme, `${family}-foreground`), colour(theme, family)),
        ).toBeGreaterThanOrEqual(4.5);
      });

      /**
       * A dialog is `bg-card`, not `bg-background`, and in the light theme those
       * are different surfaces (#F8FAFC against pure white). The participation
       * window's "right answer" sits on a card, so the page measurement alone
       * would not have covered where it is actually read.
       */
      it(`--${family} reads on a ${theme} card`, () => {
        expect(contrast(colour(theme, family), colour(page, 'card'))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  /**
   * The dark success is the SAME triple the sidebar's active row already uses.
   * Asserted rather than left to coincidence: it is one green in this product,
   * and two that differ by a shade would read as a mistake nobody could name.
   */
  it('reuses the sidebar’s green for success in the dark theme', () => {
    expect(token('.dark', 'success')).toBe(token('.dark', 'sidebar-accent-foreground'));
  });
});
