import { describe, expect, it } from 'vitest';
import { frameAncestorsValue, parseOrigins } from '@/lib/widget/origins';

describe('the origin allowlist', () => {
  it('accepts a host with a scheme, and a port', () => {
    expect(parseOrigins('https://radio.com.br\nhttp://localhost:3000')).toEqual({
      ok: true,
      origins: ['https://radio.com.br', 'http://localhost:3000'],
    });
  });

  // A trailing slash never matches what a browser sends, and the failure is
  // "the widget does not load" -- which nothing logs and no screen shows.
  it('names the entry it refused', () => {
    expect(parseOrigins('https://radio.com.br/')).toEqual({
      ok: false,
      bad: 'https://radio.com.br/',
    });
  });

  // THE REFUSAL IS THE DEFAULT. An empty list means nowhere, and the one thing
  // this function must never do is turn "unconfigured" into "anywhere".
  it('turns an empty list into none, never into a wildcard', () => {
    expect(frameAncestorsValue([])).toBe("'none'");
  });

  // THE SECOND PRODUCER, and the reason this case exists at all. parseOrigins
  // cannot emit a blank entry, so while it was the only caller `length === 0`
  // was the whole of the empty case. src/lib/widget/frame-cache.ts is fed by an
  // HTTP response, and `['']` joins to the empty string -- `frame-ancestors `
  // with no value, which a browser treats as malformed rather than as a
  // refusal, on the one path in this product where falling open means every
  // widget is embeddable from anywhere with nothing on any screen to say so.
  it('treats a blank entry as the empty case, whatever else is in the list', () => {
    expect(frameAncestorsValue([''])).toBe("'none'");
    // Refused WHOLE rather than filtered down to the good entry: a list with a
    // blank in it did not come from anywhere this product writes to.
    expect(frameAncestorsValue(['https://radio.com.br', ''])).toBe("'none'");
  });

  // Comma is the other separator the interface promises, alongside newline.
  it('also splits on commas', () => {
    expect(parseOrigins('https://radio.com.br,http://localhost:3000')).toEqual({
      ok: true,
      origins: ['https://radio.com.br', 'http://localhost:3000'],
    });
  });

  // Blank lines are a textarea artefact, not an operator's intent. Refusing
  // one as "the entry it refused" would name an empty string back at them,
  // which tells them nothing they could act on.
  it('drops blank lines rather than refusing them', () => {
    expect(parseOrigins('https://radio.com.br\n\n\nhttp://localhost:3000\n')).toEqual({
      ok: true,
      origins: ['https://radio.com.br', 'http://localhost:3000'],
    });
  });

  // public.are_origins (0159) requires a scheme -- a bare host is not an
  // origin a browser would ever send as Sec-Fetch or in frame-ancestors
  // matching, so this must refuse it exactly as the CHECK does.
  it('refuses a host with no scheme, matching the database CHECK', () => {
    expect(parseOrigins('radio.com.br')).toEqual({ ok: false, bad: 'radio.com.br' });
  });

  // The CHECK's port group is `{1,5}` digits, character for character. A
  // 5-digit port is the widest one Postgres accepts; a 6th digit must refuse
  // here too, or the console would accept an origin the database then rejects.
  it('accepts a 5-digit port and refuses a 6-digit one, matching the CHECK', () => {
    expect(parseOrigins('http://localhost:65535')).toEqual({
      ok: true,
      origins: ['http://localhost:65535'],
    });
    expect(parseOrigins('http://localhost:123456')).toEqual({
      ok: false,
      bad: 'http://localhost:123456',
    });
  });
});
