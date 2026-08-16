import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Block 25 moved the colour maths into one place: this file and
// theme-tokens.test.ts both need it, and two copies of WCAG's luminance formula
// in one directory is the quiet kind of duplication -- one gets corrected and
// the other goes on reporting numbers nobody re-derives.
import { colour, contrast, hex, token } from './colour';
/**
 * The brand's colour, asserted against the file that actually paints it.
 *
 * This is not ceremony over a constant. `--primary` is written as an HSL
 * triple because that is the format shadcn's token layer requires, and
 * `254.9 87.4% 50.2%` does not look like #4811EF to any reader — so the one
 * change this test exists to catch is somebody tidying those decimals into
 * round numbers and moving the brand colour by a shade, silently, in a file
 * nobody diffs closely.
 *
 * The contrast assertions pin the OTHER half of the decision: why light and
 * dark carry different purples at all.
 */
describe('the brand colour', () => {
  it('is exactly #4811EF in the light theme', () => {
    expect(hex(colour(':root', 'primary'))).toBe('#4811ef');
  });

  it('is the colour the focus ring is drawn in too', () => {
    // A ring in the old brand colour around a button in the new one is the
    // kind of leftover nobody sees until they use a keyboard.
    expect(token(':root', 'ring')).toBe(token(':root', 'primary'));
    expect(token('.dark', 'ring')).toBe(token('.dark', 'primary'));
  });
});

describe('what the brand colour has to survive', () => {
  it('carries readable text on it in the light theme', () => {
    expect(contrast(colour(':root', 'primary-foreground'), colour(':root', 'primary'))).toBeGreaterThanOrEqual(4.5);
  });

  it('carries readable text on it in the dark theme', () => {
    expect(contrast(colour('.dark', 'primary-foreground'), colour('.dark', 'primary'))).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * WCAG 2.1 SC 1.4.11. A solid button has no border: its fill against the
   * page is the only thing that says a control is there, and 3:1 is the floor
   * for that.
   *
   * THIS IS THE MEASUREMENT THAT FORCED TWO PURPLES. #4811EF against the dark
   * theme's near-black page measures 2.3:1 and fails here, which is why the
   * dark block carries a lighter tint of the same hue rather than the brand
   * colour itself — the same trade the emerald palette before it made, in the
   * same direction.
   */
  it('is visible as a control against its own page, in both themes', () => {
    expect(contrast(colour(':root', 'primary'), colour(':root', 'background'))).toBeGreaterThanOrEqual(3);
    expect(contrast(colour('.dark', 'primary'), colour('.dark', 'background'))).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The browser tab. There was no icon at all until this change, and the failure
 * mode of losing it again is silent: Next's `icon.png` convention is a FILE in
 * a directory, referenced from no source line, so nothing else in this project
 * would notice its deletion.
 */
describe('the icons a browser asks for', () => {
  const PNG_HEADER = 8 + 4 + 4; // signature, chunk length, "IHDR"

  function dimensions(path: string): { width: number; height: number } {
    const bytes = readFileSync(join(process.cwd(), path));
    return {
      width: bytes.readUInt32BE(PNG_HEADER),
      height: bytes.readUInt32BE(PNG_HEADER + 4),
    };
  }

  it.each(['src/app/icon.png', 'src/app/apple-icon.png', 'public/brand/pulchatx-mark.png'])(
    '%s exists and is square',
    (path) => {
      expect(existsSync(join(process.cwd(), path)), `${path} is missing`).toBe(true);
      const { width, height } = dimensions(path);
      expect(width, `${path} is ${width}x${height}`).toBe(height);
    },
  );
});
