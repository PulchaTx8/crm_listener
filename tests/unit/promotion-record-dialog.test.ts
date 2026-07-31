import { describe, expect, it } from 'vitest';
import { nextRecordAfterFailedRead } from '@/app/(app)/promotions/promotion-record-dialog';

/**
 * Fix-round finding #2: a failed re-read (refresh() after a write, or the
 * dialog's very first load) must not erase a record already on screen for
 * THIS promotion — doing so unmounts everything under it, including the
 * import form's own local report on rows that, by the time refresh() ran,
 * were already written. Tested as a pure function rather than through the
 * component: this project's unit tests run in vitest's `node` environment
 * with no DOM (vitest.config.ts), so there is no render to assert against
 * here.
 */
describe('nextRecordAfterFailedRead', () => {
  it('keeps the record when a refresh of THIS promotion fails', () => {
    const record = { id: 'promo-1', name: 'Summer draw' };
    expect(nextRecordAfterFailedRead(record, 'promo-1')).toBe(record);
  });

  it('returns null when there is nothing on screen yet (the first load failing)', () => {
    expect(nextRecordAfterFailedRead(null, 'promo-1')).toBeNull();
  });

  // The bug this guards against in the other direction: a stale record from a
  // PREVIOUS promotion must never be kept and shown under a new promotion's
  // title just because the new one's own first read failed.
  it('discards a stale record that belongs to a different promotion', () => {
    const record = { id: 'promo-1', name: 'Summer draw' };
    expect(nextRecordAfterFailedRead(record, 'promo-2')).toBeNull();
  });
});
