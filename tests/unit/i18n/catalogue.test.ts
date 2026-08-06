import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '@/i18n/locales';

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

  it('has no empty value anywhere', () => {
    // An empty string passes a key-parity check and renders as nothing at all,
    // which on screen is indistinguishable from a broken component.
    for (const locale of AVAILABLE_LOCALES) {
      const flat = JSON.stringify(load(locale));
      expect(flat, `${locale}.json holds an empty value`).not.toMatch(/:\s*""/);
    }
  });
});
