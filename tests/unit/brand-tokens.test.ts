import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(CSS);
  if (!found) throw new Error(`globals.css has no ${selector} block`);
  return found[1]!;
}

function token(selector: string, name: string): string {
  const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(themeBlock(selector));
  if (!found) throw new Error(`${selector} declares no --${name}`);
  return found[1]!.trim();
}

type Rgb = [number, number, number];

/** The same conversion a browser makes for `hsl(H S% L%)`. */
function hslToRgb(triple: string): Rgb {
  const parts = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triple);
  if (!parts) throw new Error(`not an HSL triple: ${triple}`);
  const h = Number(parts[1]);
  const s = Number(parts[2]) / 100;
  const l = Number(parts[3]) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const base: Rgb =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return base.map((v) => Math.round((v + m) * 255)) as Rgb;
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function colour(selector: string, name: string): Rgb {
  return hslToRgb(token(selector, name));
}

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
