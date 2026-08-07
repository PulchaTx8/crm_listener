/**
 * Width and height from the file's own bytes.
 *
 * NOT a general image library, and small only because the bucket accepts
 * exactly two formats (0143): everything else is answered `null` and refused
 * upstream. Reading this on the server is what makes the pixel ceiling a
 * decision rather than a suggestion -- the browser check that runs first exists
 * so the operator reads a sentence before waiting for an upload, not as a
 * boundary.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Markers between C0 and CF that are NOT a frame header. C4 is the Huffman
 * table, C8 is reserved and CC is arithmetic coding -- all three are ordinary
 * length-prefixed segments, and treating one as a frame would read a table's
 * contents as a picture's size.
 */
const NOT_A_FRAME = new Set([0xc4, 0xc8, 0xcc]);

function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walked segment by segment rather than searched for the FFC0 pair. A search
  // finds that pair inside the thumbnail an EXIF block carries, and answers
  // with the thumbnail's size -- which would let a forty-megapixel photograph
  // past the ceiling this reader exists to enforce.
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];

    // Fill bytes, and the standalone markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // The end of the file, or the start of the entropy-coded scan -- past which
    // there is no segment structure left to walk. A frame header not seen by
    // now is not going to be found.
    if (marker === 0xd9 || marker === 0xda) return null;

    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPng(bytes) ?? readJpeg(bytes);
}
