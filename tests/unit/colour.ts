import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The colour maths two test files need, in one place.
 *
 * It lived inside `brand-tokens.test.ts` until Block 25 wanted the same
 * conversions to measure `--success` and `--warning`. A second copy of WCAG's
 * luminance formula in the same directory is one idea in two places — and the
 * failure mode is the quiet kind, where one copy is corrected and the other goes
 * on reporting numbers nobody re-derives.
 *
 * Not a `.test.ts`: vitest would collect a file with no tests in it and report
 * it as an empty suite.
 */

export const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/**
 * The body of the first rule whose selector matches, brace-counted rather than
 * regex-terminated.
 *
 * Counting is what lets a caller reach INSIDE `@media` — the block Block 25 has
 * to compare against `.dark` sits nested one level deeper, and a non-greedy
 * `[\s\S]*?\}` stops at the first closing brace whatever it belongs to.
 */
export function ruleBody(selector: string, from = 0): string {
  const at = CSS.indexOf(selector, from);
  if (at === -1) throw new Error(`globals.css has no ${selector}`);

  const open = CSS.indexOf('{', at);
  if (open === -1) throw new Error(`${selector} opens no block`);

  let depth = 0;
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`${selector} has no closing brace`);
}

/** Where a selector starts, so a caller can search for the next thing after it. */
export function indexOfRule(selector: string, from = 0): number {
  const at = CSS.indexOf(selector, from);
  if (at === -1) throw new Error(`globals.css has no ${selector}`);
  return at;
}

/** Every `--name: value` in a rule body, in declaration order. */
export function tokensIn(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

export function token(selector: string, name: string): string {
  const value = tokensIn(ruleBody(selector)).get(name);
  if (value === undefined) throw new Error(`${selector} declares no --${name}`);
  return value;
}

export type Rgb = [number, number, number];

/** The same conversion a browser makes for `hsl(H S% L%)`. */
export function hslToRgb(triple: string): Rgb {
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

export function hex(rgb: Rgb): string {
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

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function colour(selector: string, name: string): Rgb {
  return hslToRgb(token(selector, name));
}

/**
 * A colour at `alpha` composited over an opaque one — what Tailwind's `/10`
 * modifier actually paints, and the surface a badge's own text has to be read
 * against.
 */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((v, i) => Math.round(v * alpha + bg[i]! * (1 - alpha))) as Rgb;
}
