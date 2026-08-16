import { afterAll, describe, expect, it } from 'vitest';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 27. What pgTAP cannot reach, for the integration card (0207).
 *
 * `58_song_integrations.test.sql` asserts the table, the partial index and the
 * door's privileges against a superuser session with a null `auth.uid()`, where
 * RLS never applies. This suite drives the door through a REAL JWT, a real role
 * and a real membership.
 *
 * Two of the four cases are the only proof of their property in this repository:
 *
 *   - THE UPSERT TARGETS THE PARTIAL INDEX. `on conflict (company_id, code)
 *     where deleted_at is null` is easy to write as a plain `on conflict
 *     (company_id, code)`, which will not compile against a partial index — and
 *     easy to "fix" by widening the index instead, which compiles, passes the
 *     pgTAP file (the index would still exist, under the same name if somebody
 *     kept it) and quietly stops a retired card's code from ever being
 *     registered again. Only a second write proves which one is in place.
 *   - TWO SONGS RESOLVE ONE CARD. This is the owner's stated requirement and the
 *     whole reason the three descriptive fields are a table rather than columns
 *     on `songs`. Nothing else asserts it.
 *
 * Per this directory's standing rule, the actor is a non-owner DELEGATE in every
 * case.
 */
describe('song integrations', () => {
  it('a card of one Station is invisible from another, inside the same Organization', async () => {
    const label = `integration-isolation-${Date.now()}`;
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

    const saved = await client.rpc('save_song_integration', {
      p_company_id: customer.companyId,
      p_code: `EXT-${label}`,
      p_title: 'Asa Branca',
      p_artist: 'Luiz Gonzaga',
      p_category: 'Forro',
    });
    expect(saved.error).toBeNull();

    const here = await client
      .from('song_integrations')
      .select('id,code,title')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);
    expect(here.data?.[0]?.title).toBe('Asa Branca');

    const there = await client
      .from('song_integrations')
      .select('id')
      .eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding music.view alone, and writes nothing', async () => {
    const label = `integration-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['music.view'], [customer.companyId]);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('save_song_integration', {
      p_company_id: customer.companyId,
      p_code: `EXT-${label}`,
      p_title: 'Refused',
    });
    expect(attempt.error?.code).toBe('42501');

    // Read back with music.view, which this delegate does hold, so an empty
    // result means "no row" rather than "no permission to see one".
    const rows = await client
      .from('song_integrations')
      .select('id')
      .eq('company_id', customer.companyId);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(0);
  });

  it('a second save on the same code corrects the card rather than adding one', async () => {
    const label = `integration-upsert-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);
    const code = `EXT-${label}`;

    const first = await client.rpc('save_song_integration', {
      p_company_id: customer.companyId,
      p_code: code,
      p_title: 'First spelling',
      p_artist: 'Luiz Gonzaga',
      p_category: 'Forro',
    });
    expect(first.error).toBeNull();

    const second = await client.rpc('save_song_integration', {
      p_company_id: customer.companyId,
      p_code: code,
      p_title: 'Corrected spelling',
      p_artist: 'Luiz Gonzaga',
      // Deliberately omitted, to prove the other half of the door's contract:
      // every field is set on every call, so what is not sent is CLEARED rather
      // than left as it was. A caller wanting to keep the category sends it back.
    });
    expect(second.error).toBeNull();
    // The same row, not a second one — this is the id that proves it is an
    // update and not an insert that happened to be allowed.
    expect(second.data).toBe(first.data);

    const rows = await client
      .from('song_integrations')
      .select('id,title,artist_name,category_name')
      .eq('company_id', customer.companyId)
      .eq('code', code);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]?.title).toBe('Corrected spelling');
    expect(rows.data?.[0]?.artist_name).toBe('Luiz Gonzaga');
    expect(rows.data?.[0]?.category_name).toBeNull();
  });

  it('two songs may carry the same code and resolve one card', async () => {
    const label = `integration-shared-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);
    const code = `EXT-${label}`;

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    expect(artist.error).toBeNull();

    // Two songs, one code. songs.internal_code carries NO unique index, by
    // 0098's own design, and this is what that buys: a live version and a studio
    // version of one recording are two rows here and one row in the customer's
    // system.
    for (const title of [`Live ${label}`, `Studio ${label}`]) {
      const song = await client.rpc('create_song', {
        p_company_id: customer.companyId,
        p_title: title,
        p_artist_id: artist.data as string,
        p_internal_code: code,
      });
      expect(song.error).toBeNull();
    }

    const card = await client.rpc('save_song_integration', {
      p_company_id: customer.companyId,
      p_code: code,
      p_title: 'One song in their system',
      p_artist: `Artist ${label}`,
      p_category: 'MPB',
    });
    expect(card.error).toBeNull();

    // Both songs resolve it — the lookup getSongIntegration performs, made here
    // through the same client so RLS decides it exactly as it would on screen.
    const songs = await client
      .from('songs')
      .select('id,internal_code')
      .eq('company_id', customer.companyId)
      .eq('internal_code', code)
      .is('deleted_at', null);
    expect(songs.error).toBeNull();
    expect(songs.data).toHaveLength(2);

    const cards = await client
      .from('song_integrations')
      .select('id,title')
      .eq('company_id', customer.companyId)
      .eq('code', code)
      .is('deleted_at', null);
    expect(cards.error).toBeNull();
    // ONE card for TWO songs. If this were three columns on `songs`, this
    // assertion would read `toHaveLength(2)` and the two copies could drift.
    expect(cards.data).toHaveLength(1);
    expect(cards.data?.[0]?.title).toBe('One song in their system');
  });
});
