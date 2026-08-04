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
// Every label below feeds a fixed e-mail template in harness.ts
// (provisionCustomer's `admin-${label}@…`/`owner-${label}@…`,
// addMemberByInvitation's `member-${label}@…`) with no stamping of its own —
// unlike every other file in this suite, which stamps each label itself
// (inventory.test.ts's `inv-floor-${Date.now()}`, conversation.test.ts's
// `conv-e2e-${Date.now()}`, and so on). A bare literal here means a second
// run against a database that could not fully delete the first run's users
// (cleanupUsers' own documented limitation: a non-cascading FK from
// audit_logs/companies/invitations/roles can leave one behind) collides on
// createUser before a single case runs. One stamp for the whole file, reused
// everywhere a label feeds an e-mail, is enough: the requirement is only that
// two RUNS never ask for the same address, not that every label be
// independently unique within a single run.
const STAMP = Date.now();

describe('Block 7a — the music catalogue across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`music7a-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station 7a');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it('refuses to register anything without music.manage', async () => {
    const viewer = await grantRoleWith(customer, `music-viewer-${STAMP}`, ['music.view']);
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
    const manager = await grantRoleWith(customer, `music-manager-a-${STAMP}`, ['music.manage'], [
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
    const manager = await grantRoleWith(customer, `music-manager-b-${STAMP}`, ['music.manage'], [
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

    const { data: otherArtist, error: otherArtistError } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist over there',
    });
    expect(otherArtistError).toBeNull();

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

    const { data: thereArtist, error: thereArtistError } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist there',
    });
    expect(thereArtistError).toBeNull();
    const { error: thereSongError } = await owner.rpc('create_song', {
      p_company_id: secondCompanyId,
      p_title: 'Song there',
      p_artist_id: thereArtist as string,
    });
    expect(thereSongError).toBeNull();

    const viewer = await grantRoleWith(customer, `music-one-station-${STAMP}`, ['music.view'], [
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

    const { data: genreId, error: createError } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'GENRE',
      p_name: 'Retired genre',
    });
    expect(createError).toBeNull();

    const { data: beforeArchive } = await owner.from('music_genres').select('name');
    expect((beforeArchive ?? []).map((g) => g.name)).toContain('Retired genre');

    const { error: archiveError } = await owner.rpc('archive_music_reference', {
      p_kind: 'GENRE',
      p_id: genreId as string,
    });
    expect(archiveError).toBeNull();

    const { data: genres } = await owner.from('music_genres').select('name');
    expect((genres ?? []).map((g) => g.name)).not.toContain('Retired genre');
  });

  it('refuses to archive an artist a live song still names', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: artistId, error: createError } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Still in use',
    });
    expect(createError).toBeNull();
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
    const viewer = await grantRoleWith(customer, `music-readonly-${STAMP}`, ['music.view']);
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
    expect(writeError?.code).toBe('42501');
  });
});
