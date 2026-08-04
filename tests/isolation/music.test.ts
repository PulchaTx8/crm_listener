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
 * Block 7a's tenant boundary, proved the only way it can be: with real users
 * holding real, narrower grants.
 *
 * Every case here is invisible to pgTAP, which runs as superuser and so gets
 * `true` from has_permission unconditionally. That is not a gap in the pgTAP
 * suite — it is the reason this file exists and the reason it is written in
 * the same task as the functions, never at the end of the block.
 */
describe('Block 7a — the music catalogue across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer('music7a');
    secondCompanyId = await addCompany(customer, 'Second Station 7a');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it('refuses to register anything without music.manage', async () => {
    const viewer = await grantRoleWith(customer, 'music-viewer', ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Should not exist',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses a Station the caller holds nothing in, without saying it exists', async () => {
    // The grant is in the FIRST Station only; the call names the second.
    const manager = await grantRoleWith(customer, 'music-manager-a', ['music.manage'], [
      customer.companyId,
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Wrong Station',
    });

    expect(error?.code).toBe('42501');
  });

  it('never answers P0002 for an id the caller may not see', async () => {
    const manager = await grantRoleWith(customer, 'music-manager-b', ['music.manage'], [
      customer.companyId,
    ]);
    const owner = await signInAs(customer.email, customer.password);

    // An artist the manager genuinely cannot reach: it lives in the Station
    // their role does not cover.
    const { data: hiddenId, error: createError } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Hidden artist',
    });
    expect(createError).toBeNull();

    const client = await signInAs(manager.email, manager.password);
    const { error } = await client.rpc('update_music_reference', {
      p_kind: 'ARTIST',
      p_id: hiddenId as string,
      p_name: 'Renamed from outside',
    });

    // 42501 and not P0002: an unknown id and an unreachable Station are one
    // answer from outside, which is the rule 0093 settled.
    expect(error?.code).toBe('42501');
  });

  it('refuses a song that names an artist from another Station', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: otherArtist } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist over there',
    });

    const { error } = await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Cross-station song',
      p_artist_id: otherArtist as string,
    });

    // Checked in the database, not on the screen — even for the owner, who
    // holds music.manage in both Stations and so passes every permission gate.
    expect(error?.code).toBe('P0002');
  });

  it('shows a caller only the catalogue of the Stations they can reach', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: hereArtist } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Artist here',
    });
    await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Song here',
      p_artist_id: hereArtist as string,
    });

    const { data: thereArtist } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist there',
    });
    await owner.rpc('create_song', {
      p_company_id: secondCompanyId,
      p_title: 'Song there',
      p_artist_id: thereArtist as string,
    });

    const viewer = await grantRoleWith(customer, 'music-one-station', ['music.view'], [
      customer.companyId,
    ]);
    const client = await signInAs(viewer.email, viewer.password);

    const { data: songs, error } = await client.from('songs').select('title, company_id');
    expect(error).toBeNull();

    const titles = (songs ?? []).map((s) => s.title);
    expect(titles).toContain('Song here');
    expect(titles).not.toContain('Song there');
  });

  it('hides an archived record from the ordinary read path entirely', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: genreId } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'GENRE',
      p_name: 'Retired genre',
    });

    await owner.rpc('archive_music_reference', { p_kind: 'GENRE', p_id: genreId as string });

    const { data: genres } = await owner.from('music_genres').select('name');
    expect((genres ?? []).map((g) => g.name)).not.toContain('Retired genre');
  });

  it('refuses to archive an artist a live song still names', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: artistId } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Still in use',
    });
    await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Depends on the artist',
      p_artist_id: artistId as string,
    });

    const { error } = await owner.rpc('archive_music_reference', {
      p_kind: 'ARTIST',
      p_id: artistId as string,
    });

    expect(error?.code).toBe('23503');
  });

  it('lets a caller with music.view read but never write', async () => {
    const viewer = await grantRoleWith(customer, 'music-readonly', ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error: readError } = await client.from('artists').select('id').limit(1);
    expect(readError).toBeNull();

    // No INSERT grant exists for `authenticated` on any of the six tables
    // (0099), so this is refused by the grant, before RLS is consulted.
    const { error: writeError } = await client
      .from('artists')
      .insert({
        organization_id: customer.organizationId,
        company_id: customer.companyId,
        name: 'Through the back door',
      });
    expect(writeError).not.toBeNull();
  });
});
