import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOrigins } from '@/lib/widget/frame-cache';

/**
 * Block 17a, Task 9. THE REFUSAL BRANCHES, which are the only ones an e2e test
 * cannot reach.
 *
 * tests/e2e/widget-headers.spec.ts proves the two answers a running server can
 * be made to give -- a seeded installation frames where it said, an unknown key
 * frames nowhere. Everything else this function must survive is a database that
 * is down, slow, or answering something unexpected, and none of those can be
 * staged against a real Supabase without breaking it for every other spec in
 * the suite. They are also exactly the paths where a "let us make this more
 * resilient" change would fall open, so they are the ones worth pinning.
 *
 * Each case uses a KEY OF ITS OWN. The cache is module scope by design (it is
 * an Edge instance's memory), so a shared key would let one case answer for the
 * next and every assertion below would still pass.
 */
const answers = vi.fn();

function key(name: string): string {
  return `pw_${name}`;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  answers.mockReset();
  vi.stubGlobal('fetch', answers);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** What PostgREST hands back for a jsonb-returning RPC. */
function body(value: unknown, ok = true) {
  return { ok, json: async () => value };
}

describe('the frame-ancestors lookup', () => {
  it('returns the origins the installation named', async () => {
    answers.mockResolvedValue(body({ found: true, origins: ['https://radio.com.br'] }));

    expect(await frameOrigins(key('found'))).toEqual(['https://radio.com.br']);
  });

  it('asks once for the same key, then answers from memory', async () => {
    // The whole reason this file exists rather than a bare fetch in the
    // middleware: without it every widget load by every listener is a database
    // round trip on the Edge, before anything is rendered.
    answers.mockResolvedValue(body({ found: true, origins: ['https://radio.com.br'] }));

    await frameOrigins(key('cached'));
    await frameOrigins(key('cached'));

    expect(answers).toHaveBeenCalledTimes(1);
  });

  it('frames nowhere for a key the database does not know', async () => {
    // 0161 answers this same shape for an unknown key, a disabled installation
    // and an archived one alike -- one refusal, three causes.
    answers.mockResolvedValue(body({ found: false, origins: [] }));

    expect(await frameOrigins(key('unknown'))).toEqual([]);
  });

  it('frames nowhere when the request throws', async () => {
    answers.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    expect(await frameOrigins(key('throws'))).toEqual([]);
  });

  it('frames nowhere when the database does not answer in time', async () => {
    // The abort the two-second ceiling raises. A widget that does not appear is
    // a better answer than a page that hangs on a database that is not
    // answering -- and a far better one than a page that decides, because
    // nobody replied, that anybody may embed it.
    vi.useFakeTimers();
    answers.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = frameOrigins(key('slow'));
    await vi.advanceTimersByTimeAsync(2_500);

    expect(await pending).toEqual([]);
    vi.useRealTimers();
  });

  it('frames nowhere when the answer is not a success', async () => {
    answers.mockResolvedValue(body({ message: 'permission denied' }, false));

    expect(await frameOrigins(key('denied'))).toEqual([]);
  });

  it.each([
    ['a body that is not an object', 'nope'],
    ['an envelope with no found flag', { origins: ['https://radio.com.br'] }],
    ['origins that are not a list', { found: true, origins: 'https://radio.com.br' }],
    ['a list holding something that is not a string', { found: true, origins: [42] }],
    ['a list holding a blank entry', { found: true, origins: [''] }],
    // THE GRAMMAR, not merely "a non-empty string". What comes back here is
    // spliced verbatim into a frame-ancestors directive; `isOrigin` is the
    // pattern the console validates with and 0159's CHECK enforces, and it
    // admits no space, no semicolon and no newline -- so an entry that reached
    // the wire could not close the directive and open another one.
    ['an origin with no scheme', { found: true, origins: ['radio.com.br'] }],
    ['a wildcard somebody hoped would work', { found: true, origins: ['*'] }],
    [
      'an entry carrying a second directive',
      { found: true, origins: ["https://radio.com.br; script-src 'unsafe-inline'"] },
    ],
    ['an entry carrying a newline', { found: true, origins: ['https://radio.com.br\nx: y'] }],
  ])('frames nowhere for %s', async (name, value) => {
    // The database CHECK (are_origins, 0159) cannot produce any of these, so
    // seeing one means the answer did not come from where this code thinks it
    // did. Salvaging the readable part of such a list is how a frame-ancestors
    // directive nobody intended gets onto the wire.
    answers.mockResolvedValue(body(value));

    expect(await frameOrigins(key(name.replace(/\s/g, '-')))).toEqual([]);
  });

  it('does not remember a failure, so a blip lasts one request and not a minute', async () => {
    // Only an authoritative answer is cached. Caching an unreachable database
    // would turn a moment's outage into a full minute of refusal for a Station
    // whose configuration is perfectly correct -- and the retry costs nothing,
    // because both branches refuse until one of them succeeds.
    answers.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    answers.mockResolvedValue(body({ found: true, origins: ['https://radio.com.br'] }));

    expect(await frameOrigins(key('blip'))).toEqual([]);
    expect(await frameOrigins(key('blip'))).toEqual(['https://radio.com.br']);
  });

  it('spends no round trip on an empty key', async () => {
    // `/w/` with nothing after it. It cannot be an installation, and asking
    // would pay a round trip to be told so.
    expect(await frameOrigins('')).toEqual([]);
    expect(answers).not.toHaveBeenCalled();
  });

  it('refuses rather than throwing when the environment is not configured', async () => {
    // This runs before every route in the product, so a missing variable must
    // refuse framing rather than throw a middleware exception onto requests
    // that have nothing to do with a widget.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');

    expect(await frameOrigins(key('no-env'))).toEqual([]);
    expect(answers).not.toHaveBeenCalled();
  });
});
