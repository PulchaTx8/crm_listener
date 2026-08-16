import { afterAll, describe, expect, it } from 'vitest';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 27. What pgTAP cannot reach.
 *
 * `57_music_categories.test.sql` proves the shape against a session it sets by
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
 * category is the one reference of the five that a FOREIGN KEY CANNOT FULLY
 * JUDGE: `songs_category_company_fk` references
 * `music_categories_id_company_unique`, a non-partial constraint — a foreign key
 * cannot reference a partial index — so it proves the Station and is blind to
 * `deleted_at`. Both refusals live in `assert_song_references_live`'s fifth
 * block (0205) and nowhere else.
 */
describe('music categories', () => {
  it('a category of one Station is invisible from another, inside the same Organization', async () => {
    const label = `music-category-isolation-${Date.now()}`;
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
      p_kind: 'CATEGORY',
      p_name: `Sertanejo ${label}`,
    });
    expect(created.error).toBeNull();

    const here = await client
      .from('music_categories')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);

    const there = await client
      .from('music_categories')
      .select('id')
      .eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding music.view alone, and writes nothing', async () => {
    const label = `music-category-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['music.view'], [customer.companyId]);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Refused ${label}`,
    });
    expect(attempt.error?.code).toBe('42501');

    // The refusal is not merely a message: nothing reached the table. Read back
    // with music.view, which this delegate does hold, so an empty result means
    // "no row" rather than "no permission to see one".
    const rows = await client
      .from('music_categories')
      .select('id')
      .eq('company_id', customer.companyId);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(0);
  });

  it('cannot be archived while a live song wears it, and can once the song lets go', async () => {
    const label = `music-category-inuse-${Date.now()}`;
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

    const category = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Category ${label}`,
    });
    expect(category.error).toBeNull();

    const song = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_category_id: category.data as string,
    });
    expect(song.error).toBeNull();

    // 23503 — the same refusal an artist or a genre in use gets, from the same
    // branch of the same function. This is the half that says the CATEGORY arm
    // of archive_music_reference's count actually looks at songs.category_id.
    const refused = await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data as string,
    });
    expect(refused.error?.code).toBe('23503');

    const detached = await client.rpc('update_song', {
      p_song_id: song.data as string,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_category_id: null,
    });
    expect(detached.error).toBeNull();

    // And this is the other half: the refusal above was about the song, not
    // about the category being unarchivable in general. Without it, a guard that
    // simply always refused would pass the assertion above.
    const archived = await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data as string,
    });
    expect(archived.error).toBeNull();
  });

  it('a song cannot borrow a category from another Station', async () => {
    const label = `music-category-crossed-${Date.now()}`;
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
      p_kind: 'CATEGORY',
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
      p_category_id: foreign.data as string,
    });
    expect(attempt.error?.code).toBe('P0002');
  });

  it('a song cannot name an archived category', async () => {
    const label = `music-category-archived-${Date.now()}`;
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

    const category = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Retired ${label}`,
    });
    expect(category.error).toBeNull();

    const archived = await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data as string,
    });
    expect(archived.error).toBeNull();

    // THE FOREIGN KEY CANNOT CATCH THIS. songs_category_company_fk references a
    // non-partial unique constraint, so it cannot see deleted_at — it would let
    // this insert through. The refusal lives in assert_song_references_live's
    // fifth block and nowhere else, which means an edit dropping those four
    // lines would leave an archived category silently choosable again with every
    // other suite green.
    const attempt = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data as string,
      p_category_id: category.data as string,
    });
    expect(attempt.error?.code).toBe('P0002');
  });
});
