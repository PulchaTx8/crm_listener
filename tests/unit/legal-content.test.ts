import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES } from '@/i18n/locales';
import { LEGAL_SLUGS, legalDocument } from '@/content/legal';

/**
 * What this catches, and why a translation review would not.
 *
 * Three copies of one legal document drift by ONE CLAUSE at a time: a
 * translator merges two sections, or drops a list a lawyer added last month,
 * and every page still renders. Comparing the SHAPE of the three — how many
 * sections, in what order — makes that a red test rather than a discovery in a
 * regulator's letter. It cannot check meaning, and does not pretend to.
 */
describe('every legal document has the same shape in every language', () => {
  for (const slug of LEGAL_SLUGS) {
    it(`${slug} has the same section count in all three locales`, () => {
      const counts = AVAILABLE_LOCALES.map((l) => legalDocument(slug, l).sections.length);
      expect(new Set(counts).size).toBe(1);
    });

    /**
     * Headings differ by language, so identity is compared by the section's
     * own stable `id` — which is also what an anchor link in the policy points
     * at, so a drift here breaks a citation as well as the translation.
     */
    it(`${slug} has the same section ids, in the same order, in all three locales`, () => {
      const ids = AVAILABLE_LOCALES.map((l) =>
        legalDocument(slug, l).sections.map((s) => s.id).join(','),
      );
      expect(new Set(ids).size).toBe(1);
    });

    it(`${slug} carries a title and an updated date in every locale`, () => {
      for (const locale of AVAILABLE_LOCALES) {
        const doc = legalDocument(slug, locale);
        expect(doc.title.trim()).not.toBe('');
        expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});

describe('the product name', () => {
  /**
   * The owner's source text spells it "PulChatX" throughout and the product is
   * "PulchatX". This is the one spelling error that would ship on a page whose
   * whole purpose is to be quoted.
   */
  it('is never spelled with a capital C, in any document or language', () => {
    for (const slug of LEGAL_SLUGS) {
      for (const locale of AVAILABLE_LOCALES) {
        expect(JSON.stringify(legalDocument(slug, locale))).not.toMatch(/PulChatX/);
      }
    }
  });
});
