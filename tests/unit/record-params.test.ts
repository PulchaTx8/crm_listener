import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRecordParam, withRecord } from '@/lib/record-params';

const TABS = ['data', 'stations', 'consents'] as const;

describe('parseRecordParam', () => {
  it('reads a record and its tab', () => {
    expect(parseRecordParam({ record: 'abc', tab: 'consents' }, TABS)).toEqual({
      recordId: 'abc',
      tab: 'consents',
    });
  });

  it('falls back to the first tab when the tab is unknown', () => {
    expect(parseRecordParam({ record: 'abc', tab: 'nope' }, TABS)).toEqual({
      recordId: 'abc',
      tab: 'data',
    });
  });

  // Every value here arrives from a URL, so every value is hostile. None of
  // these may throw, and none may open a record. Annotated as a tuple array
  // rather than inferred: heterogeneous object literals infer as a union that
  // `it.each` cannot spread, and the error only surfaces under tsc.
  const hostile: [Record<string, string | undefined>, string][] = [
    [{}, 'absent'],
    [{ record: '' }, 'empty'],
    [{ record: '   ' }, 'whitespace'],
    [{ tab: 'consents' }, 'a tab with no record'],
  ];

  it.each(hostile)('returns no record for a %s parameter (%s)', (raw) => {
    expect(parseRecordParam(raw, TABS).recordId).toBeNull();
  });
});

describe('withRecord', () => {
  it('adds the record to an existing query without disturbing it', () => {
    expect(withRecord('q=ana&sort=name', 'abc', 'data')).toBe('q=ana&sort=name&record=abc&tab=data');
  });

  // The bug this prevents: URLSearchParams.append would leave BOTH records in
  // the query, and whichever the reader picks first wins silently.
  it('replaces a record already there rather than appending a second', () => {
    expect(withRecord('q=ana&record=old&tab=notes', 'new', 'data')).toBe(
      'q=ana&record=new&tab=data',
    );
  });

  it('removes both keys when the record closes, leaving the list state alone', () => {
    expect(withRecord('q=ana&record=abc&tab=notes', null, null)).toBe('q=ana');
  });

  it('omits the tab when there is none, so a plain open stays a short URL', () => {
    expect(withRecord('', 'abc', null)).toBe('record=abc');
  });

  it('drops a stale tab when the new open names none', () => {
    expect(withRecord('record=abc&tab=notes', 'abc', null)).toBe('record=abc');
  });
});

/**
 * A source-shape test, and deliberately so.
 *
 * Everything above exercises parseRecordParam with a real array and passes no
 * matter what, which is exactly why none of it caught the defect Block 4b
 * found: every caller of this function is a Server Component, and until that
 * block the six of them imported their tab tuple from a module beginning with
 * 'use client'. React hands a Server Component a client reference for that
 * import rather than the value, and every property read off one answers
 * `undefined` — so `?record=<id>&tab=<slug>` called `undefined` as `includes`
 * and threw during the server render on all six screens, while `?record=<id>`
 * on its own quietly took a null tab and validated nothing. The account of both
 * halves is in src/lib/record-params.ts.
 *
 * That is a fact about the module graph, not about anything this function does
 * with its argument, so nothing runnable under vitest can observe it: there is
 * no RSC transform here, and importing the dialog module just gives back the
 * real array. Reading the graph is the only way to assert it, and a rule the
 * whole codebase has to keep is worth one ugly test.
 *
 * Written against the graph rather than against a list of six paths on purpose:
 * a seventh screen that opens a record is covered the day it is written, and
 * the rule survives someone later moving the tuples back out of
 * src/lib/record-params.ts into a neutral module per screen — which is a shape
 * this project could reasonably choose, and is not the mistake.
 */
describe('the tab tuples a page validates against', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
  const APP_ROOT = join(SRC_ROOT, 'app');

  function pageFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return pageFiles(full);
      return entry === 'page.tsx' ? [full] : [];
    });
  }

  /** A module is a client module when its very first statement is the directive. */
  function isClientModule(source: string): boolean {
    return /^\s*(['"])use client\1/.test(source);
  }

  function resolveImport(fromFile: string, specifier: string): string {
    const base = specifier.startsWith('@/')
      ? join(SRC_ROOT, specifier.slice(2))
      : resolvePath(fromFile, '..', specifier);
    for (const extension of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      try {
        const candidate = `${base}${extension}`;
        statSync(candidate);
        return candidate;
      } catch {
        // Next extension.
      }
    }
    throw new Error(`could not resolve '${specifier}' from ${fromFile}`);
  }

  /**
   * Every page that calls parseRecordParam, paired with the module its tab
   * tuple comes from. A page that calls it without importing a `*_TABS` binding
   * is a failure rather than a skip: it means the tuple is being spelled some
   * other way this test cannot see, and the guard would otherwise go quietly
   * blind.
   */
  const callers = pageFiles(APP_ROOT)
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => source.includes('parseRecordParam('))
    .map(({ file, source }) => {
      const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)];
      const tabsImport = imports.find(([, names]) => /\b\w+_TABS\b/.test(names ?? ''));
      if (!tabsImport) throw new Error(`${file} calls parseRecordParam but imports no *_TABS`);
      return { file, specifier: tabsImport[2] as string };
    });

  // The six screens of Block 3c, 4a and the admin console. Asserted as a floor
  // rather than an exact number so that adding a screen does not fail this line
  // — but a discovery that silently finds nothing does.
  it('finds every screen that opens a record', () => {
    expect(callers.length).toBeGreaterThanOrEqual(6);
  });

  // A test per screen rather than one loop inside a single test, so that a
  // failure names the screen instead of the first one that happened to break.
  for (const { file, specifier } of callers) {
    const screen = file.replace(/.*[\\/]src[\\/]/, 'src/').replace(/\\/g, '/');
    it(`${screen} takes its tabs from a module a Server Component can read`, () => {
      expect(isClientModule(readFileSync(resolveImport(file, specifier), 'utf8'))).toBe(false);
    });
  }
});
