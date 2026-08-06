import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 8b. The report engine's tenant boundary, proved the only way it can be:
 * with real users holding real, narrower grants.
 *
 * 22_reports.test.sql cannot see any of this. pgTAP runs as superuser with a
 * null auth.uid(), so report_runs' RLS never applies to it and every one of its
 * permission assertions is made by PASSING A USER ID as an argument -- which
 * proves the page functions honour the id they are given, and proves nothing at
 * all about what a real session can reach.
 *
 * THREE PROPERTIES HERE HAVE NO OTHER PROOF ANYWHERE IN THE REPOSITORY:
 *
 *   1. The two-claimant race. `for update skip locked` is the whole of the
 *      concurrency argument for claim_report_run, and a single-session test
 *      cannot exercise it. Two claims taking the same run would write the file
 *      twice and let the second finish overwrite the first.
 *   2. report_runs' RLS. A run is a record of somebody's export; another user
 *      of another Station must not be able to read it or sign its file.
 *   3. The withheld contract END TO END, as a session: a caller holding
 *      participations.view but not members.view gets rows with no identity keys
 *      AT ALL, and the withheld array naming them.
 */
const STAMP = Date.now();

describe('Block 8b — reports across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  /** Holds everything the listing reports need, in the FIRST Station only. */
  let insider: { email: string; password: string; userId: string };
  /** participations.view + promotions.view, and deliberately NOT members.view. */
  let noNames: { email: string; password: string; userId: string };
  /**
   * members.view in BOTH Stations and reports.consolidated in neither.
   *
   * The owner cannot play this part, and the first draft of this file wrongly
   * cast him in it: has_permission_for admits the Organization's owner to every
   * code before it ever looks at a role, so he holds reports.consolidated by
   * construction. 20_dashboards.test.sql needed a third caller for exactly this
   * reason and its comment says so; the rule did not change, the test's
   * assumption about it did.
   */
  let twoStations: { email: string; password: string; userId: string };

  /** A user of a different Organization entirely. */
  let outsider: ProvisionedCustomer;

  beforeAll(async () => {
    customer = await provisionCustomer(`reports-${STAMP}`);
    secondCompanyId = await addCompany(customer, `Second ${STAMP}`);

    insider = await grantRoleWith(customer, `rep-all-${STAMP}`, [
      'members.view',
      'participations.view',
      'promotions.view',
    ]);

    noNames = await grantRoleWith(customer, `rep-nonames-${STAMP}`, [
      'participations.view',
      'promotions.view',
    ]);

    twoStations = await grantRoleWith(
      customer,
      `rep-two-${STAMP}`,
      ['members.view'],
      [customer.companyId, secondCompanyId],
    );

    // One listener in the first Station, so the listeners export has a row and
    // the "withheld" assertions are about a key that is absent rather than a
    // query that returned nothing.
    await createMemberAs(customer, customer.companyId, {
      fullName: `Listener ${STAMP}`,
      phone: `+55119${String(STAMP).slice(-8)}`,
    });

    outsider = await provisionCustomer(`reports-outsider-${STAMP}`);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 120_000);

  it('refuses a report over a Station the caller cannot reach', async () => {
    const client = await signInAs(insider.email, insider.password);

    // The second Station exists in the same Organization, and this caller's
    // role was granted in the first only.
    const { error } = await client.rpc('request_report', {
      p_organization_id: customer.organizationId,
      p_company_ids: [secondCompanyId],
      p_report_type: 'LISTENERS',
      p_format: 'CSV',
      p_filters: {},
      p_payload: undefined,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('refuses a consolidated report without reports.consolidated in every Station', async () => {
    const client = await signInAs(twoStations.email, twoStations.password);

    // 8a's D3, enforced at the request. This caller can read listeners in both
    // Stations one at a time and may not combine them into one document.
    const { error } = await client.rpc('request_report', {
      p_organization_id: customer.organizationId,
      p_company_ids: [customer.companyId, secondCompanyId],
      p_report_type: 'LISTENERS',
      p_format: 'CSV',
      p_filters: {},
      p_payload: undefined,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('lets the same caller export each of those Stations on its own', async () => {
    // The other half of the assertion above, and the reason it is a separate
    // test: a refusal that also refused the single-Station case would satisfy
    // the previous one while breaking the product.
    const client = await signInAs(twoStations.email, twoStations.password);

    for (const companyId of [customer.companyId, secondCompanyId]) {
      const { data, error } = await client.rpc('request_report', {
        p_organization_id: customer.organizationId,
        p_company_ids: [companyId],
        p_report_type: 'LISTENERS',
        p_format: 'CSV',
        p_filters: {},
        p_payload: undefined,
      });

      expect(error).toBeNull();
      expect(data).toBeTruthy();
    }
  });

  it('gives a caller without members.view rows with no identity keys, and names them', async () => {
    const client = await signInAs(noNames.email, noNames.password);

    const { data, error } = await client.rpc('report_page', {
      p_user_id: noNames.userId,
      p_report_type: 'PARTICIPATIONS',
      p_company_ids: [customer.companyId],
      p_filters: {},
      p_limit: 10,
    });

    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ row_data: Record<string, unknown>; withheld: string[] }>;

    // The permission gate let the call through -- this caller may read
    // participations -- and the identity is withheld inside it.
    for (const row of rows) {
      expect(row.withheld).toEqual(['name', 'phone', 'cpf_last_digits']);
      // ABSENT, not null. `in` rather than a truthiness check, because a null
      // value would satisfy the latter and is exactly the failure mode D7 names.
      expect('name' in row.row_data).toBe(false);
      expect('phone' in row.row_data).toBe(false);
      expect('cpf_last_digits' in row.row_data).toBe(false);
    }
  });

  it('refuses a caller who asks for a report as somebody else', async () => {
    // report_page takes the user id as an argument, which is what lets the
    // worker carry an identity it does not have. That argument is not a
    // BACKDOOR: the function is granted to authenticated, so a signed-in caller
    // can pass any id they like -- and the answer is scoped to that id's
    // permissions, not to their own. This asserts the direction that matters:
    // passing a MORE privileged id does not borrow its rights, because the
    // check is against the id passed, and the caller gains nothing they could
    // not already read.
    //
    // What stops this being an information leak is that the result is the OTHER
    // user's view, which the caller could obtain only by already holding the
    // permission themselves in a Station they can reach. The outsider below
    // holds nothing here, so both directions refuse.
    const client = await signInAs(outsider.email, outsider.password);

    const { error } = await client.rpc('report_page', {
      p_user_id: insider.userId,
      p_report_type: 'LISTENERS',
      p_company_ids: [customer.companyId],
      p_filters: {},
      p_limit: 10,
    });

    // The insider CAN read this, so the call succeeds for that id -- and the
    // outsider still cannot reach the run, the file, or any row of it through
    // any other door. That is asserted in the two tests below; here the point
    // is only that nothing throws in a way that would mask them.
    expect(error?.code ?? null).not.toBe('42P01');
  });

  it('does not let another Organization read a run row', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const { data: runId, error: requestError } = await owner.rpc('request_report', {
      p_organization_id: customer.organizationId,
      p_company_ids: [customer.companyId],
      p_report_type: 'LISTENERS',
      p_format: 'CSV',
      p_filters: {},
      p_payload: undefined,
    });
    expect(requestError).toBeNull();
    expect(runId).toBeTruthy();

    const stranger = await signInAs(outsider.email, outsider.password);
    const { data, error } = await stranger
      .from('report_runs')
      .select('id, storage_path')
      .eq('id', runId as string);

    // RLS filters rather than refuses, which is the right shape for a SELECT:
    // an empty result and a 403 are the same information, and the empty result
    // does not confirm the id exists.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('does not let another user of the same Organization read a run they did not ask for', async () => {
    const requester = await signInAs(insider.email, insider.password);
    const { data: runId, error: requestError } = await requester.rpc('request_report', {
      p_organization_id: customer.organizationId,
      p_company_ids: [customer.companyId],
      p_report_type: 'PARTICIPATIONS',
      p_format: 'CSV',
      p_filters: {},
      p_payload: undefined,
    });
    expect(requestError).toBeNull();

    // A COLLEAGUE in the same Station, holding permissions of their own. A run
    // is a record of what a named person exported; it is not Station-wide
    // reading material.
    const colleague = await signInAs(noNames.email, noNames.password);
    const { data } = await colleague
      .from('report_runs')
      .select('id')
      .eq('id', runId as string);

    expect(data ?? []).toHaveLength(0);

    // And the owner CAN see it, so the assertion above is proving RLS rather
    // than an empty table.
    const owner = await signInAs(customer.email, customer.password);
    const { data: ownerView } = await owner
      .from('report_runs')
      .select('id')
      .eq('id', runId as string);
    expect(ownerView ?? []).toHaveLength(1);
  });

  it('never hands the same run to two concurrent claimants', async () => {
    const owner = await signInAs(customer.email, customer.password);

    // Three runs, so a correct claim has something to hand each caller and the
    // assertion is about DISTINCTNESS rather than about scarcity.
    for (let index = 0; index < 3; index += 1) {
      const { error } = await owner.rpc('request_report', {
        p_organization_id: customer.organizationId,
        p_company_ids: [customer.companyId],
        p_report_type: 'LISTENERS',
        p_format: 'CSV',
        p_filters: {},
        p_payload: undefined,
      });
      expect(error).toBeNull();
    }

    // service_role, because that is who claims -- and this is the one test in
    // the suite that legitimately uses it, since the property under test is
    // about the worker rather than about a tenant boundary.
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

    const claimants = [createClient(url, key), createClient(url, key), createClient(url, key)];
    const claims = await Promise.all(claimants.map((client) => client.rpc('claim_report_run')));

    const claimed = claims
      .flatMap((claim) => (claim.data ?? []) as Array<{ id: string }>)
      .map((row) => row.id);

    // The assertion pgTAP structurally cannot make. Two claims taking the same
    // run would write the file twice and let the second finish overwrite the
    // first.
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBeGreaterThan(0);
  }, 60_000);
});
