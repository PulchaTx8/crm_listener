import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '@/i18n/locales';
import { GENDER_VALUES } from '@/lib/conversation/steps';
import { REQUESTED_FIELD_ORDER } from '@/schemas/promotions';

/**
 * Block 12a, D8. What stops a translation from being quietly incomplete.
 *
 * In this block it guards one catalogue and looks like ceremony. In Block 12b
 * it is the only thing standing between "we translated it" and a Spanish screen
 * carrying three English sentences that nobody noticed.
 */
const DIRECTORY = join(process.cwd(), 'messages');

function keysOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIRECTORY, `${locale}.json`), 'utf8'));
}

describe('the message catalogues', () => {
  it('has a file for every language the product offers', () => {
    const present = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace('.json', ''))
      .sort();
    expect(present).toEqual([...AVAILABLE_LOCALES].sort());
  });

  it('holds exactly the same keys in every language', () => {
    const reference = keysOf(load(DEFAULT_LOCALE)).sort();
    for (const locale of AVAILABLE_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const theirs = keysOf(load(locale)).sort();
      expect(theirs, `${locale}.json does not match ${DEFAULT_LOCALE}.json`).toEqual(reference);
    }
  });

  it('has a file on disk for every answer resolveLocale can give', () => {
    // The pure-function test asserts the same invariant against the constant;
    // this one asserts it against the filesystem, which is what the import in
    // src/i18n/request.ts actually reaches for. Both have to hold: the constant
    // could open a language whose catalogue nobody wrote.
    for (const locale of AVAILABLE_LOCALES) {
      expect(() => load(locale), `messages/${locale}.json is missing`).not.toThrow();
    }
  });

  it('has no empty value anywhere', () => {
    // An empty string passes a key-parity check and renders as nothing at all,
    // which on screen is indistinguishable from a broken component.
    for (const locale of AVAILABLE_LOCALES) {
      const flat = JSON.stringify(load(locale));
      expect(flat, `${locale}.json holds an empty value`).not.toMatch(/:\s*""/);
    }
  });
});

/**
 * The keys nothing else in this repository can see.
 *
 * `tests/unit/i18n/usage.test.ts` proves that every `t('literal')` in the source
 * names a key that exists. It reads the source with a regular expression, so it
 * can only see keys spelled out at the call site — and the widget's field label
 * is `t(`field_${step.field}`)`, the gender options are `t(`gender_${value}`)`,
 * and every one of those is invisible to it.
 *
 * THIS IS NOT HYPOTHETICAL. Block 28 added `country` to
 * `promotion_requested_field`, and the widget's label for it was never written:
 * a promotion asking for a country rendered the literal string `field_country`
 * to a visitor, and every gate in this repository stayed green for five weeks.
 * The gender block found it by adding the tenth field beside it.
 *
 * Only the DEFAULT locale is checked here. "holds exactly the same keys in every
 * language" above already carries the other two, and asserting all three would
 * report the same missing key three times.
 */
describe('the keys built at the call site', () => {
  const catalogue = load(DEFAULT_LOCALE) as Record<string, Record<string, unknown>>;

  it.each(REQUESTED_FIELD_ORDER)('the widget can label the %s field', (field) => {
    expect(catalogue.widget?.[`field_${field}`], `widget.field_${field} is missing`).toBeTruthy();
  });

  it.each(GENDER_VALUES)('both forms and the widget can name the %s option', (value) => {
    expect(catalogue.members?.[`gender_${value}`], `members.gender_${value} is missing`).toBeTruthy();
    expect(
      catalogue.widget?.[`field_gender_${value}`],
      `widget.field_gender_${value} is missing`,
    ).toBeTruthy();
  });
});
