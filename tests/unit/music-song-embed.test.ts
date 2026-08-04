import { describe, expect, it, vi } from 'vitest';

/**
 * Block 7a, final review finding I1: a live song whose artist is hidden by RLS
 * must cost one cell, not the whole Songs list.
 *
 * PostgREST resolves a to-one embed as a LEFT JOIN and returns `null` for the
 * embedded object when the parent row is invisible. 0099's policy on `artists`
 * is `deleted_at is null and has_permission('music.view', company_id)`, so an
 * archived artist is unreadable for every caller including the owner, and a
 * live song naming one comes back with `artist_id` set and `artists: null`.
 *
 * The row shape below is not invented. It was read off a real PostgREST
 * response: a real user holding music.view, a Station with two songs, one
 * artist archived — the live song came back `artists: {"name": ...}` and the
 * other came back `artists: null` with `artist_id` still set. Before the fix,
 * mapping that second row threw `TypeError: Cannot read properties of null
 * (reading 'name')` inside listSongsPage, which page.tsx turns into "Could not
 * load the catalogue" for the entire Station — every song, not just the bad
 * one, and with no route back through the UI to reach the offending song.
 *
 * 0103 closes the concurrency window that could newly produce such a song, so
 * this state is no longer reachable through the RPCs; it stays reachable
 * through Block 9's ETL, which writes these tables directly, and through any
 * row written before 0103. That is why the guard is worth a pin even though
 * the door it came through is now shut.
 */
const { songRows } = vi.hoisted(() => ({
  songRows: [
    {
      id: 'song-live',
      title: 'A song whose artist is readable',
      artist_id: 'artist-live',
      label_id: null,
      genre_id: null,
      nationality: null,
      vocal: null,
      duration_seconds: null,
      internal_code: null,
      legacy_id: null,
      created_at: '2026-08-04T12:00:00.000Z',
      artists: { name: 'Cartola' },
      record_labels: null,
      music_genres: null,
    },
    {
      id: 'song-hidden-artist',
      title: 'A song whose artist RLS hides',
      artist_id: 'artist-archived',
      label_id: null,
      genre_id: null,
      nationality: null,
      vocal: null,
      duration_seconds: null,
      internal_code: null,
      legacy_id: null,
      created_at: '2026-08-04T12:00:01.000Z',
      // The whole point of the fixture.
      artists: null,
      record_labels: null,
      music_genres: null,
    },
  ],
}));

/**
 * A stand-in for the query builder rather than for PostgREST: every builder
 * method returns the same thenable, so the chain listSongsPage builds
 * (.select/.eq/.is/.or/.order/.limit) and the head count it awaits directly
 * both resolve to the fixture above. `maybeSingle` resolves to the single bad
 * row instead, which is the shape getSongById reads.
 */
vi.mock('@/lib/supabase/user-client', () => {
  const thenable = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void) => resolve(result);
          }
          if (property === 'maybeSingle') {
            return () =>
              thenable({
                data: { ...songRows[1], company_id: 'company-1' },
                error: null,
              });
          }
          return () => thenable(result);
        },
      },
    );

  return {
    createUserClient: async () => ({
      from: () => thenable({ data: songRows, error: null, count: songRows.length }),
    }),
  };
});

const { getSongById, listSongsPage } = await import('@/services/music');

describe('a song whose artist is hidden by RLS', () => {
  it('does not take the whole list down, and reports the artist as unreadable', async () => {
    const page = await listSongsPage({
      companyId: 'company-1',
      sort: 'title',
      direction: 'asc',
      cursor: null,
      cursorSide: 'after',
    });

    // The readable row is still there: the bad row costs nothing but itself.
    expect(page.rows).toHaveLength(2);
    const [readable, hidden] = page.rows;
    expect(readable?.artistName).toBe('Cartola');

    // Null, not '' and not a placeholder: the service reports "cannot be read"
    // and the Songs grid decides what an operator sees (it renders
    // "Unavailable", deliberately not the '—' it uses for an absent label).
    expect(hidden?.artistName).toBeNull();
    // artist_id is NOT NULL in the database and survives regardless — the
    // embed's visibility and the column's value are different facts.
    expect(hidden?.artistId).toBe('artist-archived');
  });

  it('lets the record dialog open too', async () => {
    const found = await getSongById('song-hidden-artist');
    expect(found?.song.artistName).toBeNull();
    expect(found?.song.title).toBe('A song whose artist RLS hides');
  });
});
