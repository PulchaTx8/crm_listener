/**
 * The countries this product offers, as ISO 3166-1 alpha-2.
 *
 * THIS LIST AND 0213's `country_alpha2` NAME THE SAME SET, and they have to:
 * `update_company_profile` raises 22023 for a country its resolver does not
 * know, so a code offered here and absent there would be an option that refuses
 * to save. `tests/unit/countries.test.ts` holds the two together — it is the
 * only thing that can, because one of them is SQL.
 *
 * It is deliberately short. It covers where this product is sold plus the
 * diaspora destinations design D10 names, and it is not a world gazetteer:
 * every entry is a row an operator scrolls past, and a 249-item select is how a
 * required field becomes one people get wrong.
 *
 * THE NAMES ARE NOT TRANSLATED IN messages/*.json, and that is the point of
 * `Intl.DisplayNames`. Three locales times this list is ninety strings that
 * would have to be written, reviewed and kept in step for no editorial
 * decision — the platform already knows that "BR" is *Brasil* in Portuguese and
 * *Brazil* in English, and knows it for every locale this product might add
 * next. What messages/*.json is for is wording somebody chose.
 */
export const COUNTRY_CODES = [
  'AO', 'AR', 'AU', 'BE', 'BO', 'BR', 'CA', 'CH', 'CL', 'CO',
  'CV', 'DE', 'EC', 'ES', 'FR', 'GB', 'GW', 'IE', 'IT', 'JP',
  'MX', 'MZ', 'NL', 'PE', 'PT', 'PY', 'US', 'UY', 'VE',
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

export function isCountryCode(value: string): value is CountryCode {
  return (COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * The country's name in the reader's language, falling back to the code.
 *
 * `fallback: 'none'` rather than the default, and the difference is the whole
 * reason this wrapper exists: left at the default, a code CLDR has no name for
 * comes back AS THE CODE, which looks identical to this function's own
 * fallback — so the two cases are indistinguishable and neither can be tested.
 * With 'none' the platform answers undefined and the `?? code` below is the one
 * place that decides. (CLDR does name a few codes that are not countries — 'ZZ'
 * is "Unknown Region" — and those come back named under either setting; that is
 * CLDR having an answer, not a fallback firing.)
 *
 * The try/catch is for the locale, not the code: `Intl.DisplayNames` throws on
 * a malformed language tag, and a select rendering nothing is worse than one
 * rendering "GW".
 */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The options a country select renders, sorted by NAME in the reader's own
 * language rather than by code — *Alemanha* files under A for a Portuguese
 * reader and *Germany* under G for an English one, and a list sorted by code
 * would be alphabetical in neither.
 */
export function countryOptions(locale: string): { code: string; name: string }[] {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
}
