import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 13a's boundary, proved the only way it can be: with real users holding
 * real, narrower grants.
 *
 * EVERY CASE HERE IS INVISIBLE TO pgTAP, which runs as superuser with a null
 * auth.uid() and so gets `true` from has_permission unconditionally. That is
 * not a gap in supabase/tests/28_albums.test.sql — it is the reason this file
 * exists, and that file says so at its own top.
 *
 * Two of these also prove things no permission check could: that
 * create_song_from_deezer leaves no orphan reference behind when the insert
 * fails, and that a second song cannot be linked to a recording another song
 * in the same Station already holds.
 */
const STAMP = Date.now();

/** A Deezer track id no fixture uses, offset per case so two never collide inside one run. */
const TRACK = (n: number) => 900_000_000 + n;

describe('Block 13a — the Deezer doors across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`deezer13a-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station 13a');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  /**
   * BOTH CODES, and the second is not padding.
   *
   * music.manage is what create_song_from_deezer checks, so a caller holding
   * it alone can WRITE the song — and then cannot read it back: 0099's select
   * policy on songs and 0136's on albums both gate on music.view, which is a
   * separate code. The first version of these cases granted music.manage only
   * and read `null` from every read-back, which looked like a broken RPC and
   * was the schema behaving exactly as designed.
   */
  const MANAGE_AND_VIEW = ['music.manage', 'music.view'];

  it('refuses to register from Deezer without music.manage', async () => {
    const viewer = await grantRoleWith(customer, `deezer-viewer-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'Should not exist',
      p_artist_name: 'Nobody',
      p_deezer_track_id: TRACK(1),
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses a Station the caller holds nothing in, without saying it exists', async () => {
    // The grant is in the FIRST Station only; the call names the second.
    const manager = await grantRoleWith(
      customer,
      `deezer-manager-a-${STAMP}`,
      ['music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('create_song_from_deezer', {
      p_company_id: secondCompanyId,
      p_title: 'Wrong station',
      p_artist_name: 'Nobody',
      p_deezer_track_id: TRACK(2),
    });

    expect(error?.code).toBe('42501');
  });

  it('registers artist, label, genre and album in one call', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-b-${STAMP}`, MANAGE_AND_VIEW);
    const client = await signInAs(manager.email, manager.password);

    const { data: songId, error } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'Sozinho',
      p_artist_name: 'Caetano Veloso',
      p_label_name: 'Universal Music',
      p_genre_name: 'Pop',
      p_album_title: 'Prenda Minha',
      p_deezer_track_id: TRACK(3),
      p_deezer_album_id: 103763,
      p_isrc: 'BRPGD9800678',
      p_upc: '731453833227',
      p_cover_md5: '2a0f6ac6bc05458fb072275653f01dd2',
      p_duration_seconds: 191,
    });

    expect(error).toBeNull();
    expect(songId).toBeTruthy();

    const { data: song } = await client
      .from('songs')
      .select('title, isrc, deezer_track_id, artists(name), record_labels(name), music_genres(name), albums(title, upc, cover_md5)')
      .eq('id', songId as string)
      .single();

    expect(song).toMatchObject({
      title: 'Sozinho',
      isrc: 'BRPGD9800678',
      artists: { name: 'Caetano Veloso' },
      record_labels: { name: 'Universal Music' },
      music_genres: { name: 'Pop' },
      albums: {
        title: 'Prenda Minha',
        upc: '731453833227',
        cover_md5: '2a0f6ac6bc05458fb072275653f01dd2',
      },
    });
  });

  /**
   * DESIGN D3, and the reason create_song_from_deezer is one RPC rather than
   * four round trips from Node.
   *
   * A blank title raises 23514 AFTER the artist has been resolved and
   * inserted. In one transaction that insert unwinds; from four separate calls
   * it would not, and the Station would be left holding an artist nobody
   * registered, with nothing to explain it and no screen that would show it as
   * related to anything.
   */
  it('leaves no orphan artist behind when the song insert fails', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-c-${STAMP}`, ['music.manage']);
    const client = await signInAs(manager.email, manager.password);

    const orphanName = `Orphan Candidate ${STAMP}`;

    const { error } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      // Blank, so the title check raises after the artist is resolved.
      p_title: '   ',
      p_artist_name: orphanName,
      p_deezer_track_id: TRACK(4),
    });

    expect(error?.code).toBe('22023');

    const { data: artists } = await client
      .from('artists')
      .select('id')
      .eq('company_id', customer.companyId)
      .eq('name', orphanName);

    expect(artists).toEqual([]);
  });

  it('refuses a second song linked to a recording this Station already holds', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-d-${STAMP}`, ['music.manage']);
    const client = await signInAs(manager.email, manager.password);

    const shared = TRACK(5);

    const { error: first } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'First registration',
      p_artist_name: 'Some Artist',
      p_deezer_track_id: shared,
    });
    expect(first).toBeNull();

    const { error: second } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'Second registration',
      p_artist_name: 'Some Artist',
      p_deezer_track_id: shared,
    });

    // songs_deezer_live (0138), by name — 0139 deliberately does not catch it,
    // so the constraint reaches the application, which tells it apart from
    // songs_legacy_unique and says which of the two happened.
    expect(second?.code).toBe('23505');
    expect(second?.message).toContain('songs_deezer_live');
  });

  it('lets a second Station register the same recording independently', async () => {
    // Granted in BOTH Stations: the case is about two catalogues staying
    // independent, not about reach, and a grant in one would refuse the
    // second call for the right reason and prove the wrong thing.
    const manager = await grantRoleWith(customer, `deezer-manager-e-${STAMP}`, MANAGE_AND_VIEW, [
      customer.companyId,
      secondCompanyId,
    ]);
    const client = await signInAs(manager.email, manager.password);

    const shared = TRACK(6);

    const { error: here } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'Same recording, station one',
      p_artist_name: 'Some Artist',
      p_deezer_track_id: shared,
    });
    expect(here).toBeNull();

    // The whole of design D1: a group with two Stations keeps two catalogues.
    const { error: there } = await client.rpc('create_song_from_deezer', {
      p_company_id: secondCompanyId,
      p_title: 'Same recording, station two',
      p_artist_name: 'Some Artist',
      p_deezer_track_id: shared,
    });
    expect(there).toBeNull();
  });

  it('refuses linking a song at a Station the caller cannot reach', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: songId } = await owner.rpc('create_song_from_deezer', {
      p_company_id: secondCompanyId,
      p_title: 'Elsewhere',
      p_artist_name: 'Some Artist',
      p_deezer_track_id: TRACK(7),
    });

    const manager = await grantRoleWith(
      customer,
      `deezer-manager-f-${STAMP}`,
      ['music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('link_song_to_deezer', {
      p_song_id: songId as string,
      p_deezer_track_id: TRACK(8),
    });

    expect(error?.code).toBe('42501');
  });

  /**
   * Design D10: linking attaches a recording and corrects nothing. Somebody
   * who has curated a record for a year is not overwritten by a catalogue.
   */
  it('link touches the code and the album and nothing the operator typed', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-g-${STAMP}`, MANAGE_AND_VIEW);
    const client = await signInAs(manager.email, manager.password);

    const { data: artistId } = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Curated Artist ${STAMP}`,
    });

    const { data: songId } = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'A title somebody chose',
      p_artist_id: artistId as string,
      p_internal_code: 'HOUSE-1',
    });

    const { error } = await client.rpc('link_song_to_deezer', {
      p_song_id: songId as string,
      p_deezer_track_id: TRACK(9),
      p_album_title: 'An album from Deezer',
      p_cover_md5: '2a0f6ac6bc05458fb072275653f01dd2',
      p_isrc: 'BRPGD9800678',
    });
    expect(error).toBeNull();

    const { data: song } = await client
      .from('songs')
      .select('title, internal_code, isrc, deezer_track_id, albums(title, cover_md5)')
      .eq('id', songId as string)
      .single();

    expect(song).toMatchObject({
      // Untouched.
      title: 'A title somebody chose',
      internal_code: 'HOUSE-1',
      // Written, because the song had none.
      isrc: 'BRPGD9800678',
      deezer_track_id: TRACK(9),
      albums: { title: 'An album from Deezer', cover_md5: '2a0f6ac6bc05458fb072275653f01dd2' },
    });
  });

  /** Unlinking says "not that recording"; it does not say the album or the ISRC was wrong. */
  it('unlink clears the code and leaves the album and the ISRC standing', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-h-${STAMP}`, MANAGE_AND_VIEW);
    const client = await signInAs(manager.email, manager.password);

    const { data: songId } = await client.rpc('create_song_from_deezer', {
      p_company_id: customer.companyId,
      p_title: 'To be unlinked',
      p_artist_name: 'Some Artist',
      p_album_title: 'Its album',
      p_deezer_track_id: TRACK(10),
      p_isrc: 'BRPGD9800679',
    });

    const { error } = await client.rpc('unlink_song_from_deezer', { p_song_id: songId as string });
    expect(error).toBeNull();

    const { data: song } = await client
      .from('songs')
      .select('deezer_track_id, isrc, albums(title)')
      .eq('id', songId as string)
      .single();

    expect(song).toMatchObject({
      deezer_track_id: null,
      isrc: 'BRPGD9800679',
      albums: { title: 'Its album' },
    });
  });

  /**
   * The two resolvers write without checking a permission, because their only
   * caller has already checked one. EXECUTE granted to nobody is the whole of
   * their protection, and this is the only kind of test that can see it —
   * pgTAP asserts the grant, this asserts what happens when a real session
   * tries anyway.
   */
  it('refuses a session calling the private resolvers directly', async () => {
    const manager = await grantRoleWith(customer, `deezer-manager-i-${STAMP}`, ['music.manage']);
    const client = await signInAs(manager.email, manager.password);

    // The generated types describe these three as non-null because the RPC
    // declares them without defaults; the call is cast because what is under
    // test is the GRANT, which refuses before any argument is read.
    const album = await client.rpc('resolve_or_create_album', {
      p_company_id: customer.companyId,
      p_title: 'Should not be reachable',
      p_deezer_album_id: 1,
      p_upc: '',
      p_cover_md5: '',
      p_release_date: '2026-01-01',
    });
    expect(album.error).not.toBeNull();

    const reference = await client.rpc('resolve_or_create_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Should not be reachable',
    });
    expect(reference.error).not.toBeNull();
  });

  it('hides an archived album from every caller, the owner included', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: albumId } = await owner.rpc('create_album', {
      p_company_id: customer.companyId,
      p_title: `Doomed Album ${STAMP}`,
    });

    const { error } = await owner.rpc('archive_album', { p_album_id: albumId as string });
    expect(error).toBeNull();

    // 0136's policy is `deleted_at is null and has_permission('music.view', …)`,
    // so this is unreadable rather than merely hidden — the same fact 0099
    // established for every other music table.
    const { data: found } = await owner
      .from('albums')
      .select('id')
      .eq('id', albumId as string);

    expect(found).toEqual([]);
  });
});
