import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery } from '@/lib/integrations/deezer/transport';
import { createDeezerClient } from '@/lib/integrations/deezer/client';

/**
 * Deezer answers everything with HTTP 200, successes and failures alike, so
 * these fixtures deliberately keep `ok: true` even for the error bodies. That
 * is not a shortcut in the test — it is the behaviour under test.
 */
function respondWith(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('buildSearchQuery', () => {
  it('quotes each filter and joins them', () => {
    expect(buildSearchQuery({ track: 'Sozinho', artist: 'Caetano Veloso' })).toBe(
      'track:"Sozinho" artist:"Caetano Veloso"',
    );
  });

  it('drops blank filters instead of sending empty terms', () => {
    expect(buildSearchQuery({ track: '  ', artist: 'x', album: '' })).toBe('artist:"x"');
  });

  it('is empty when nothing was typed, so the caller can refuse to search', () => {
    expect(buildSearchQuery({})).toBe('');
  });

  // A quote left in place closes its own filter, and everything after it is
  // read as a new one — a search that silently becomes a different search.
  it('strips double quotes so a term cannot break out of its own filter', () => {
    expect(buildSearchQuery({ track: 'a"b' })).toBe('track:"ab"');
  });
});

describe('the Deezer client', () => {
  // THE ONE THAT WILL BE FORGOTTEN. Deezer answers a bad id with HTTP 200 and
  // an error object in the body, so `response.ok` is true for a request that
  // found nothing. Verified against the live API on 2026-08-07:
  //   GET /track/999999999999 -> 200 {"error":{"type":"DataException","code":800}}
  it('treats an error body on HTTP 200 as a failure', async () => {
    const fetchImpl = respondWith({
      error: { type: 'DataException', message: 'no data', code: 800 },
    });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.album(999999999999)).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('reports a quota refusal separately from a missing row', async () => {
    const fetchImpl = respondWith({
      error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 },
    });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.search({ track: 'x' })).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('maps a search hit, ISRC and preview included', async () => {
    const fetchImpl = respondWith({
      data: [
        {
          id: 921568,
          title: 'Sozinho (Ao Vivo)',
          title_short: 'Sozinho',
          duration: 191,
          isrc: 'BRPGD9800678',
          preview: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1',
          artist: { id: 232, name: 'Caetano Veloso' },
          album: {
            id: 103763,
            title: 'Prenda Minha',
            md5_image: '2a0f6ac6bc05458fb072275653f01dd2',
          },
        },
      ],
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.search({ track: 'Sozinho' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual({
      id: 921568,
      // The full title, not title_short: the version is what tells two
      // recordings apart.
      title: 'Sozinho (Ao Vivo)',
      artistName: 'Caetano Veloso',
      albumId: 103763,
      albumTitle: 'Prenda Minha',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
      durationSeconds: 191,
      isrc: 'BRPGD9800678',
      previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1',
      // Block 31a, D9. Read now, and null for a body that carries no version.
      // The field is where a cover hides when the title is clean, which is why
      // the search judges the pair rather than the title alone.
      version: null,
    });
  });

  it('searches nothing and calls nobody when every filter is blank', async () => {
    const fetchImpl = respondWith({ data: [] });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.search({ track: '   ' })).toEqual({ ok: true, value: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps the album detail, UPC, label and first genre included', async () => {
    const fetchImpl = respondWith({
      id: 103763,
      title: 'Prenda Minha',
      upc: '731453833227',
      label: 'Universal Music Mexico',
      release_date: '2014-06-17',
      md5_image: '2a0f6ac6bc05458fb072275653f01dd2',
      genres: { data: [{ id: 132, name: 'Pop' }] },
    });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.album(103763)).toMatchObject({
      ok: true,
      value: {
        upc: '731453833227',
        label: 'Universal Music Mexico',
        genreName: 'Pop',
        releaseDate: '2014-06-17',
      },
    });
  });

  it('survives an album with no genres rather than throwing', async () => {
    const fetchImpl = respondWith({
      id: 1,
      title: 'x',
      upc: null,
      label: null,
      release_date: null,
      md5_image: null,
      genres: { data: [] },
    });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.album(1)).toMatchObject({ ok: true, value: { genreName: null } });
  });

  it('reports a thrown fetch as a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = createDeezerClient({ fetchImpl });

    expect(await client.search({ track: 'x' })).toMatchObject({ ok: false, reason: 'network' });
  });

  it('reports a body that is not the shape Deezer documents as malformed', async () => {
    const fetchImpl = respondWith({ unexpected: true });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.search({ track: 'x' })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('drops a search row with no id rather than mapping a track that is not one', async () => {
    const fetchImpl = respondWith({ data: [{ title: 'no id here' }] });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.search({ track: 'x' });
    expect(result).toEqual({ ok: true, value: [] });
  });
});

/**
 * Block 17b, D4. The widget sends an integer rather than a record, so a crafted
 * payload cannot name what lands in a Station's catalogue — which means the
 * server needs a way to turn that integer back into a recording.
 */
describe('track', () => {
  it('reads one recording by id, mapped exactly as a search hit is', async () => {
    const fetchImpl = respondWith({
      id: 3135556,
      title: 'Sozinho (Ao Vivo)',
      duration: 231,
      isrc: 'BRXXX0000001',
      preview: 'https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1~hmac=y',
      artist: { name: 'Caetano Veloso' },
      album: { id: 302127, title: 'Prenda Minha', md5_image: '0123456789abcdef0123456789abcdef' },
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.track(3135556);

    expect(fetchImpl).toHaveBeenCalledWith('https://api.deezer.com/track/3135556', {
      headers: { accept: 'application/json' },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: 3135556,
        title: 'Sozinho (Ao Vivo)',
        artistName: 'Caetano Veloso',
        albumId: 302127,
        albumTitle: 'Prenda Minha',
        coverMd5: '0123456789abcdef0123456789abcdef',
        durationSeconds: 231,
        isrc: 'BRXXX0000001',
        previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1~hmac=y',
        // Mapped by the same `toTrack` the search uses -- which is what this
        // case exists to hold down -- so the field appears here too. The lookup
        // still ANSWERS for a cover: filtering by id would make a recording
        // already registered in a Station's catalogue unresolvable (Block 24).
        version: null,
      },
    });
  });

  // The module header's own verified example: GET /track/999999999999 answers
  // 200 with an error body. A `response.ok` check reads it as a success.
  it('reads a missing recording that arrived as HTTP 200 as not-found', async () => {
    const fetchImpl = respondWith({
      error: { type: 'DataException', message: 'no data', code: 800 },
    });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.track(999999999999)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('separates a quota refusal from a missing recording', async () => {
    const fetchImpl = respondWith({ error: { type: 'Exception', message: 'slow down', code: 4 } });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.track(3135556)).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('reports a body with no id as malformed rather than inventing a recording', async () => {
    const fetchImpl = respondWith({ title: 'no id here' });
    const client = createDeezerClient({ fetchImpl });

    expect(await client.track(1)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});
