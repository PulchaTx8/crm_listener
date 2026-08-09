import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { admin, cleanupUsers, provisionCustomer, seedApiCredential, type ProvisionedCustomer } from './harness';

/**
 * Block 15. The tenant boundary of the external intake API.
 *
 * THIS IS THE TEST THAT MATTERS MOST IN THE BLOCK. Everything else about these
 * two endpoints is a shape pgTAP can assert; this is the behaviour, and it is
 * the one whose failure would be a customer's catalogue appearing in another
 * customer's account.
 *
 * IT RUNS AS service_role, exactly as the routes do. That is the whole point:
 * `admin` here bypasses RLS, so nothing about these results comes from row
 * policies -- they come from the doors in 0152 resolving the Station from the
 * CREDENTIAL ROW rather than from the company_id the caller supplied. A door
 * that trusted that argument would pass every pgTAP test in the repository and
 * fail here.
 *
 * pgTAP cannot cover this: it runs as superuser with a null auth.uid(), so it
 * can prove the gate refuses an unscoped credential (34_api_intake) but not that
 * a scoped one is confined to its own Station.
 */
const STAMP = Date.now();

/** Any 64 lowercase hex characters; api_credentials_hash_shape (0148) checks only the shape. */
const hashFor = (label: string) => createHash('sha256').update(label).digest('hex');

describe('Block 15 — the intake API across Stations', () => {
  let alpha: ProvisionedCustomer;
  let beta: ProvisionedCustomer;
  let alphaKey: string;

  beforeAll(async () => {
    alpha = await provisionCustomer(`api-alpha-${STAMP}`);
    beta = await provisionCustomer(`api-beta-${STAMP}`);
    alphaKey = await seedApiCredential(alpha, hashFor(`alpha-${STAMP}`), [
      'music.manage',
      'music.request',
      'members.create',
    ]);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it("registers into the credential's own Station", async () => {
    const { data, error } = await admin.rpc('api_register_song', {
      p_credential_id: alphaKey,
      p_company_id: alpha.companyId,
      p_org: alpha.organizationId,
      p_title: 'Isolation Song',
      p_artist_name: 'Isolation Artist',
      p_external_id: `iso-${STAMP}`,
    });

    expect(error).toBeNull();
    expect((data as { created: boolean }).created).toBe(true);

    const alphaSongs = await admin
      .from('songs')
      .select('id')
      .eq('company_id', alpha.companyId);
    expect(alphaSongs.data).toHaveLength(1);
  });

  it("refuses to write into another Station even when asked to", async () => {
    // The fault this models is a bug in the ROUTE, not a hostile caller: the
    // route resolves the Station from the credential and passes it on, so a
    // mismatch means our own code got it wrong. The door refuses rather than
    // writing wherever it was pointed.
    const { error } = await admin.rpc('api_register_song', {
      p_credential_id: alphaKey,
      p_company_id: beta.companyId,
      p_org: beta.organizationId,
      p_title: 'Trespassing Song',
      p_artist_name: 'Trespassing Artist',
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('leaves the other Station with no songs and no references at all', async () => {
    // Not just "no song": the references are what a partial write would leave
    // behind, and they are the rows nothing would ever point at or explain.
    for (const table of ['songs', 'artists', 'record_labels', 'music_genres', 'albums'] as const) {
      const { data } = await admin.from(table).select('id').eq('company_id', beta.companyId);
      expect(data, `${table} in the other Station`).toHaveLength(0);
    }
  });

  it('records a request into its own Station and nothing into the other', async () => {
    const { data, error } = await admin.rpc('api_record_music_request', {
      p_credential_id: alphaKey,
      p_company_id: alpha.companyId,
      p_org: alpha.organizationId,
      p_phone: `+5511${String(STAMP).slice(-9)}`,
      p_listener_name: 'Isolation Listener',
      p_request_external_id: `iso-req-${STAMP}`,
      p_title: 'Requested Song',
      p_artist_name: 'Requested Artist',
    });

    expect(error).toBeNull();
    expect((data as { created: boolean }).created).toBe(true);

    const alphaRequests = await admin
      .from('music_requests')
      .select('id')
      .eq('company_id', alpha.companyId);
    expect(alphaRequests.data).toHaveLength(1);

    const betaRequests = await admin
      .from('music_requests')
      .select('id')
      .eq('company_id', beta.companyId);
    expect(betaRequests.data).toHaveLength(0);

    // The listener belongs to alpha's Organization and is linked to alpha's
    // Station. Members are Organization-scoped (0031), so the proof that beta
    // did not gain an audience member is on the LINK table, not on members.
    const betaLinks = await admin
      .from('member_company_links')
      .select('member_id')
      .eq('company_id', beta.companyId);
    expect(betaLinks.data).toHaveLength(0);
  });

  it('refuses to record a request into another Station', async () => {
    const { error } = await admin.rpc('api_record_music_request', {
      p_credential_id: alphaKey,
      p_company_id: beta.companyId,
      p_org: beta.organizationId,
      p_phone: `+5511${String(STAMP).slice(-9)}`,
      p_listener_name: 'Trespassing Listener',
      p_title: 'Trespassing Request',
      p_artist_name: 'Trespassing Artist',
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('is idempotent: the same external id does not write a second row', async () => {
    const before = await admin
      .from('music_requests')
      .select('id')
      .eq('company_id', alpha.companyId);

    const { data, error } = await admin.rpc('api_record_music_request', {
      p_credential_id: alphaKey,
      p_company_id: alpha.companyId,
      p_org: alpha.organizationId,
      p_phone: `+5511${String(STAMP).slice(-9)}`,
      p_listener_name: 'Isolation Listener',
      p_request_external_id: `iso-req-${STAMP}`,
      p_title: 'Requested Song',
      p_artist_name: 'Requested Artist',
    });

    expect(error).toBeNull();
    expect((data as { created: boolean }).created).toBe(false);

    const after = await admin
      .from('music_requests')
      .select('id')
      .eq('company_id', alpha.companyId);
    expect(after.data).toHaveLength(before.data!.length);
  });
});
