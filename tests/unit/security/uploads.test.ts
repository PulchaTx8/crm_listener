import { describe, expect, it } from 'vitest';
import {
  describeReceiptRejection,
  receiptExtension,
  RECEIPT_ACCEPT,
  RECEIPT_MAX_BYTES,
} from '@/lib/security/uploads';

describe('the delivery receipt allow-list', () => {
  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/heic', '.heic'],
    ['application/pdf', '.pdf'],
  ])('%s is stored as %s', (mime, extension) => {
    expect(receiptExtension(mime)).toBe(extension);
  });

  it('has no extension for a type it does not accept', () => {
    // D8. The extension comes from the validated type, never from the client's
    // filename, which is a string that goes straight into a storage key.
    expect(receiptExtension('text/html')).toBeNull();
    expect(receiptExtension('application/octet-stream')).toBeNull();
  });

  it('accepts an ordinary photograph', () => {
    expect(describeReceiptRejection({ type: 'image/jpeg', size: 2_000_000 })).toBeNull();
  });

  it('names the size when the file is too big', () => {
    const message = describeReceiptRejection({ type: 'image/jpeg', size: 40_000_000 });
    expect(message).toContain('38 MB');
    expect(message).toContain('10 MB');
  });

  it('refuses a type that is not on the list', () => {
    expect(describeReceiptRejection({ type: 'text/html', size: 100 })).toContain('image');
  });

  it('refuses an empty type rather than guessing', () => {
    // The old code fell back to application/octet-stream, which is how a file
    // with no declared type became a stored object nobody had checked.
    expect(describeReceiptRejection({ type: '', size: 100 })).toBeTruthy();
  });

  it('offers the same list to the file picker', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']) {
      expect(RECEIPT_ACCEPT).toContain(mime);
    }
  });

  it('agrees with the bucket', () => {
    // 0134 sets exactly this. Two numbers that must not drift apart.
    expect(RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
