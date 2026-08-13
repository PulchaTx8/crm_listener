import type { Locale } from '@/i18n/locales';
import type { LegalDocument } from './types';
import { privacy as privacyEn } from './privacy.en';
import { privacy as privacyPt } from './privacy.pt';
import { privacy as privacyEs } from './privacy.es';
import { terms as termsEn } from './terms.en';
import { terms as termsPt } from './terms.pt';
import { terms as termsEs } from './terms.es';
import { deleteData as deleteDataEn } from './delete-data.en';
import { deleteData as deleteDataPt } from './delete-data.pt';
import { deleteData as deleteDataEs } from './delete-data.es';

/**
 * The slugs this feature actually serves.
 *
 * Widened here, ahead of the six new modules, on purpose (task brief, Step 1):
 * the structural test in tests/unit/legal-content.test.ts iterates this
 * constant, so widening it before 'terms' and 'delete-data' exist makes the
 * test go red -- proof it covers a document generally, not only the one it was
 * written against.
 */
export const LEGAL_SLUGS = ['privacy', 'terms', 'delete-data'] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/**
 * Every document, for every locale, resolved by a plain object literal
 * instead of a dynamic import built from the arguments.
 *
 * A template-literal import (e.g. `import(\`./${slug}.${locale}\`)`) is
 * invisible to the bundler and to `tsc` — nothing here would catch a missing
 * module until the page 404s or 500s in front of a regulator. Every entry
 * below is a static `import` at the top of this file instead (nine now that
 * Task 2 has added `terms` and `delete-data`), so a missing module is a
 * compile error, not a runtime surprise. It is the staticness that matters,
 * not the count.
 */
const DOCUMENTS: Record<LegalSlug, Record<Locale, LegalDocument>> = {
  privacy: { en: privacyEn, pt: privacyPt, es: privacyEs },
  terms: { en: termsEn, pt: termsPt, es: termsEs },
  'delete-data': { en: deleteDataEn, pt: deleteDataPt, es: deleteDataEs },
};

export function legalDocument(slug: LegalSlug, locale: Locale): LegalDocument {
  return DOCUMENTS[slug][locale];
}

export type { LegalDocument, LegalSection, LegalBlock, LegalLink } from './types';
export { LegalArticle } from './render';
