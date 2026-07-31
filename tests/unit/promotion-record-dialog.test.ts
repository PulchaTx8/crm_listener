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
 *
 * Re-review of that fix (round 2) found the gap this file's `'not-found'`
 * cases close: the function used to treat every failure alike, so a
 * `not-found` on a refresh for the SAME promotion — a permission revoked
 * mid-session, or the promotion archived by someone else while this operator
 * still has it open — left a stale, still-editable record (Save button
 * included) rendered underneath a banner saying access is gone. `'not-found'`
 * is RLS answering "zero rows, right now" (record.ts's own try/catch is what
 * produces `'error'` instead), which is authoritative rather than flaky, so it
 * must clear the screen regardless of which promotion was showing.
 */
describe('nextRecordAfterFailedRead', () => {
  describe('status: error (a thrown, caught exception — the transient case)', () => {
    it('keeps the record when a refresh of THIS promotion fails', () => {
      const record = { id: 'promo-1', name: 'Summer draw' };
      expect(nextRecordAfterFailedRead(record, 'promo-1', 'error')).toBe(record);
    });

    it('returns null when there is nothing on screen yet (the first load failing)', () => {
      expect(nextRecordAfterFailedRead(null, 'promo-1', 'error')).toBeNull();
    });

    // The bug this guards against in the other direction: a stale record from
    // a PREVIOUS promotion must never be kept and shown under a new
    // promotion's title just because the new one's own first read failed.
    it('discards a stale record that belongs to a different promotion', () => {
      const record = { id: 'promo-1', name: 'Summer draw' };
      expect(nextRecordAfterFailedRead(record, 'promo-2', 'error')).toBeNull();
    });
  });

  describe('status: not-found (RLS answering zero rows — the authoritative case)', () => {
    // THE MISSING DIRECTION round 2's re-review found: before this round, a
    // `not-found` for the SAME id that was already on screen was kept, same as
    // an `error` would be — leaving an editable, stale form with a working
    // Save button rendered underneath "you do not have permission to see this
    // one". A `not-found` must clear regardless of whose id it names.
    it('clears the record even when it already named this same promotion', () => {
      const record = { id: 'promo-1', name: 'Summer draw' };
      expect(nextRecordAfterFailedRead(record, 'promo-1', 'not-found')).toBeNull();
    });

    it('clears a stale record that belongs to a different promotion', () => {
      const record = { id: 'promo-1', name: 'Summer draw' };
      expect(nextRecordAfterFailedRead(record, 'promo-2', 'not-found')).toBeNull();
    });

    it('returns null when there is nothing on screen yet', () => {
      expect(nextRecordAfterFailedRead(null, 'promo-1', 'not-found')).toBeNull();
    });
  });
});
