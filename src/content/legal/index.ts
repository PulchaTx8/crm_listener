import type { Locale } from '@/i18n/locales';
import type { LegalDocument } from './types';
import { privacy as privacyEn } from './privacy.en';
import { privacy as privacyPt } from './privacy.pt';
import { privacy as privacyEs } from './privacy.es';

/**
 * The slugs this feature actually serves.
 *
 * Limited to what exists today, ON PURPOSE (task brief, Step 4): the
 * structural test in tests/unit/legal-content.test.ts iterates this constant,
 * so widening it ahead of the content would make the test pass on modules that
 * do not exist. Task 2 adds 'terms' and 'delete-data' here alongside the six
 * modules that back them.
 */
export const LEGAL_SLUGS = ['privacy'] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/**
 * Every document, for every locale, resolved by a plain object literal
 * instead of a dynamic import built from the arguments.
 *
 * A template-literal import (e.g. `import(\`./${slug}.${locale}\`)`) is
 * invisible to the bundler and to `tsc` — nothing here would catch a missing
 * module until the page 404s or 500s in front of a regulator. This object is
 * nine static `import` statements deep, so a missing module is a compile
 * error, not a runtime surprise.
 */
const DOCUMENTS: Record<LegalSlug, Record<Locale, LegalDocument>> = {
  privacy: { en: privacyEn, pt: privacyPt, es: privacyEs },
};

export function legalDocument(slug: LegalSlug, locale: Locale): LegalDocument {
  return DOCUMENTS[slug][locale];
}

export type { LegalDocument, LegalSection, LegalBlock, LegalLink } from './types';
export { LegalArticle } from './render';
