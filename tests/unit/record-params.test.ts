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
  // these may throw, and none may open a record.
  it.each([
    [{}, 'absent'],
    [{ record: '' }, 'empty'],
    [{ record: '   ' }, 'whitespace'],
    [{ tab: 'consents' }, 'a tab with no record'],
  ])('returns no record for a %s parameter (%s)', (raw) => {
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
