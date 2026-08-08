import { describe, expect, it } from 'vitest';
import {
  ARTWORK_ACCEPT,
  ARTWORK_MAX_BYTES,
  describeArtworkRejection,
} from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';

/** A PNG is a signature, then an IHDR whose first eight payload bytes are the size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * A JPEG whose SOF0 sits behind two other segments, which is the case a reader
 * that peeks at a fixed offset gets wrong. APP0 and DQT come first, exactly as
 * a camera writes them.
 */
function jpeg(width: number, height: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00); // APP0, length 4
  parts.push(0xff, 0xdb, 0x00, 0x05, 0x00, 0x00, 0x00); // DQT, length 5
  parts.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  );
  return new Uint8Array(parts);
}

describe('readImageDimensions', () => {
  it('reads a PNG', () => {
    expect(readImageDimensions(png(1125, 600))).toEqual({ width: 1125, height: 600 });
  });

  it('reads a JPEG whose SOF0 is behind other segments', () => {
    expect(readImageDimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it('answers null for anything else, rather than guessing', () => {
    expect(readImageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it('answers null for a truncated PNG rather than reading past the end', () => {
    expect(readImageDimensions(png(10, 10).slice(0, 18))).toBeNull();
  });

  /**
   * The reason readJpeg walks the segments instead of searching for the FFC0
   * pair: an EXIF block carries a whole second JPEG, and a search finds the
   * thumbnail's frame header first. The picture below is 4000x3000 with a
   * 160x120 thumbnail buried in APP1, and a searching reader answers 160x120 --
   * which would let a forty-megapixel photograph past the ceiling.
   */
  it('reads the picture, not the thumbnail inside its EXIF block', () => {
    const thumbnail = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x00, 0xa0];
    const app1 = [0xff, 0xe1, 0x00, thumbnail.length + 2, ...thumbnail];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0];
    const bytes = new Uint8Array([0xff, 0xd8, ...app1, ...sof]);
    expect(readImageDimensions(bytes)).toEqual({ width: 4000, height: 3000 });
  });
});

describe('describeArtworkRejection', () => {
  const jpegFile = { type: 'image/jpeg', size: 1000 };

  it('accepts a banner inside every limit', () => {
    expect(describeArtworkRejection('banner', jpegFile, { width: 1125, height: 600 })).toBeNull();
  });

  it('refuses a file over five megabytes', () => {
    const message = describeArtworkRejection(
      'banner',
      { type: 'image/jpeg', size: ARTWORK_MAX_BYTES + 1 },
      { width: 100, height: 100 },
    );
    expect(message).toMatch(/5 MB/);
  });

  it('names HEIC, because that is what an iPhone hands over', () => {
    const message = describeArtworkRejection(
      'banner',
      { type: 'image/heic', size: 1000 },
      null,
    );
    expect(message).toMatch(/HEIC/);
  });

  it('refuses a banner wider than the ceiling and says what it found', () => {
    const message = describeArtworkRejection('banner', jpegFile, { width: 4032, height: 3024 });
    expect(message).toMatch(/4032/);
    expect(message).toMatch(/1920/);
  });

  it('holds a thumb to the tighter ceiling', () => {
    expect(describeArtworkRejection('thumb', jpegFile, { width: 800, height: 200 })).toMatch(/512/);
    expect(describeArtworkRejection('thumb', jpegFile, { width: 512, height: 200 })).toBeNull();
  });

  it('measures the longest side, not the width', () => {
    // A portrait photograph is the case a width-only check waves through.
    expect(describeArtworkRejection('banner', jpegFile, { width: 900, height: 4000 })).toMatch(
      /4000/,
    );
  });

  it('refuses a file whose dimensions could not be read at all', () => {
    // A JPEG by its content type whose bytes no reader recognised is not a
    // JPEG, and storing it would mean Meta fetching something it cannot render.
    expect(describeArtworkRejection('banner', jpegFile, null)).toMatch(/could not be read/i);
  });

  it('offers the picker exactly the two types the bucket accepts', () => {
    expect(ARTWORK_ACCEPT).toBe('image/jpeg,image/png');
  });
});
