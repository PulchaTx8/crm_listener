import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COUNTRY_CODES, countryName, countryOptions, isCountryCode } from '@/lib/countries';

/**
 * Block 28. The one test that can hold a TypeScript array and a SQL function to
 * the same list, because one of them is SQL and no compiler sees both.
 *
 * What it protects is not tidiness. `update_company_profile` (0213) raises
 * 22023 for a country `country_alpha2` cannot resolve, so a code this list
 * offers and that function does not know is a select option that refuses to
 * save — and the operator gets a red sentence about a country they picked from
 * the list we gave them.
 */
const MIGRATION = readFileSync('supabase/migrations/0213_country.sql', 'utf8');

/** Every ('name','XX') pair in country_alpha2's VALUES list. */
function codesInMigration(): Set<string> {
  const codes = new Set<string>();
  for (const match of MIGRATION.matchAll(/\('[a-z -]+','([A-Z]{2})'\)/g)) codes.add(match[1]!);
  return codes;
}

describe('the country list', () => {
  it('offers no code the database cannot resolve', () => {
    const resolvable = codesInMigration();
    // Read out of the migration rather than hard-coded, so this test cannot
    // pass by agreeing with a copy of the thing it is checking.
    expect(resolvable.size).toBeGreaterThan(20);
    const unresolvable = COUNTRY_CODES.filter((code) => !resolvable.has(code));
    expect(unresolvable).toEqual([]);
  });

  it('resolves every code the database knows, so no country is reachable only by typing', () => {
    const offered = new Set<string>(COUNTRY_CODES);
    const missing = [...codesInMigration()].filter((code) => !offered.has(code));
    expect(missing).toEqual([]);
  });

  it('names a country in the reader s own language', () => {
    expect(countryName('BR', 'pt')).toBe('Brasil');
    expect(countryName('BR', 'en')).toBe('Brazil');
    expect(countryName('DE', 'es')).toBe('Alemania');
  });

  it('falls back to the code rather than rendering an empty option', () => {
    // 'QQ' is unassigned and CLDR has no name for it, so `fallback: 'none'`
    // answers undefined and countryName's own `?? code` is what returns this.
    // 'ZZ' would NOT prove it — CLDR names that one "Unknown Region", so it
    // comes back named and no fallback fires.
    expect(countryName('QQ', 'en')).toBe('QQ');
  });

  it('does not silently render a name for a code the list does not offer', () => {
    // The complement of the case above, and the reason `fallback: 'none'` was
    // chosen: a code CLDR cannot name must be visibly a code.
    expect(countryName('ZZ', 'en')).toBe('Unknown Region');
    expect(isCountryCode('ZZ')).toBe(false);
  });

  it('sorts by the name the reader sees, not by the code', () => {
    // Germany is DE and *Alemanha* in Portuguese. A list sorted by code would
    // put Angola (AO) and Argentina (AR) before it; sorted by name it comes
    // between them.
    const names = countryOptions('pt').map((option) => option.name);
    expect(names.indexOf('Alemanha')).toBeLessThan(names.indexOf('Angola'));
  });

  it('is a type guard, so an arbitrary string cannot pass as a code', () => {
    expect(isCountryCode('BR')).toBe(true);
    expect(isCountryCode('br')).toBe(false);
    expect(isCountryCode('BRA')).toBe(false);
  });
});
