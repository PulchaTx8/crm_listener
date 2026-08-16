import { afterAll, describe, expect, it } from 'vitest';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 27, under Block 28's word. What pgTAP cannot reach.
 *
 * `57_songwriters.test.sql` proves the shape against a session it sets by
 * hand, as superuser with a null `auth.uid()`, where RLS never applies and
 * `has_permission` has no actor to resolve. This suite drives 0100's doors
 * through a REAL JWT, a real role and a real membership, which is the only way
 * the cross-Station claims are actually tested: the separation between two
 * Stations of one Organization only exists once there are two Stations and a
 * caller who belongs to both.
 *
 * Per this directory's standing rule, the actor is a non-owner DELEGATE in every
 * case: Block 1c shipped two defects that thirteen reviews missed because every
 * scenario had the owner driving, and the owner's bypass hid the delegate's
 * failure.
 *
 * The last two cases are the ones nothing else in this repository holds. A
 * songwriter is the one reference of the five that a FOREIGN KEY CANNOT FULLY
 * JUDGE: `songs_songwriter_company_fk` references
 * `songwriters_id_company_unique`, a non-partial constraint — a foreign key
 * cannot reference a partial index — so it proves the Station and is blind to
 * `deleted_at`. Both refusals live in `assert_song_references_live`'s fifth
 * block (0205, renamed 0211) and nowhere else.
 */
describe('songwriters', () => {
  it('a songwriter of one Station is invisible from another, inside the same Organization', async () => {
    const label = `songwriter-isolation-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // The delegate holds the permissions in BOTH Stations, so what separates
    // them below is the row's own company_id rather than a missing grant.
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'SONGWRITER',
      p_name: `Sertanejo ${label}`,
    });
    expect(created.error).toBeNull();

    const here = await client
      .from('songwriters')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);

    const there = await client
      .from('songwriters')
      .select('id')
      .eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding music.view alone, and writes nothing', async () => {
    const label = `songwriter-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['music.view'], [customer.companyId]);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'SONGWRITER',
      p_name: `Refused ${label}`,
    });
    expect(attempt.error?.code).toBe('42501');

    // The refusal is not merely a message: nothing reached the table. Read back
    // with music.view, which this delegate does hold, so an empty result means
    // "no row" rather than "no permission to see one".
    const rows = await client
      .from('songwriters')
      .select('id')
      .eq('company_id', customer.companyId);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(0);
  });

  it('cannot be archived while a live song wears it, and can once the song lets go', async () => {
    const label = `songwriter-inuse-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    expect(artist.error).toBeNull();

    const songwriter = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'SONGWRITER',
      p_name: `Songwriter ${label}`,
    });
    expect(songwriter.error).toBeNull();

    const song = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_songwriter_id: songwriter.data as string,
    });
    expect(song.error).toBeNull();

    // 23503 — the same refusal an artist or a genre in use gets, from the same
    // branch of the same function. This is the half that says the SONGWRITER
    // arm of archive_music_reference's count actually looks at
    // songs.songwriter_id.
    const refused = await client.rpc('archive_music_reference', {
      p_kind: 'SONGWRITER',
      p_id: songwriter.data as string,
    });
    expect(refused.error?.code).toBe('23503');

    // `undefined`, not null, and that IS the detach: update_song replaces every
    // field it takes on every call, and 0206 defaults this parameter to null, so
    // omitting it clears the column. The generated Args type admits nothing else
    // — Postgres reports "has a default" and no nullability, so the parameter
    // types as `string | undefined`.
    const detached = await client.rpc('update_song', {
      p_song_id: song.data as string,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_songwriter_id: undefined,
    });
    expect(detached.error).toBeNull();

    // And this is the other half: the refusal above was about the song, not
    // about the songwriter being unarchivable in general. Without it, a guard that
    // simply always refused would pass the assertion above.
    const archived = await client.rpc('archive_music_reference', {
      p_kind: 'SONGWRITER',
      p_id: songwriter.data as string,
    });
    expect(archived.error).toBeNull();
  });

  it('a song cannot borrow a songwriter from another Station', async () => {
    const label = `songwriter-crossed-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    expect(artist.error).toBeNull();

    const foreign = await client.rpc('create_music_reference', {
      p_company_id: otherCompanyId,
      p_kind: 'SONGWRITER',
      p_name: `Foreign ${label}`,
    });
    expect(foreign.error).toBeNull();

    // P0002, not a permission code, and the delegate holds music.manage in BOTH
    // Stations — so what refuses this is the row's Station, not the caller's
    // reach. The composite foreign key would refuse it too; asserting the RPC's
    // own error code is what pins WHICH refusal the operator sees.
    const attempt = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_songwriter_id: foreign.data as string,
    });
    expect(attempt.error?.code).toBe('P0002');
  });

  it('a song cannot name an archived songwriter', async () => {
    const label = `songwriter-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    expect(artist.error).toBeNull();

    const songwriter = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'SONGWRITER',
      p_name: `Retired ${label}`,
    });
    expect(songwriter.error).toBeNull();

    const archived = await client.rpc('archive_music_reference', {
      p_kind: 'SONGWRITER',
      p_id: songwriter.data as string,
    });
    expect(archived.error).toBeNull();

    // THE FOREIGN KEY CANNOT CATCH THIS. songs_songwriter_company_fk references a
    // non-partial unique constraint, so it cannot see deleted_at — it would let
    // this insert through. The refusal lives in assert_song_references_live's
    // fifth block and nowhere else, which means an edit dropping those four
    // lines would leave an archived songwriter silently choosable again with every
    // other suite green.
    const attempt = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_songwriter_id: songwriter.data as string,
    });
    expect(attempt.error?.code).toBe('P0002');
  });
});
