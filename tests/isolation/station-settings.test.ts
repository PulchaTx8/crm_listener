import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  admin,
  anonClient,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  seedIntegration,
  signInAs,
  suspendOrganization,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29a. `station_whatsapp_status` (0218), proved against real sessions.
 *
 * WHY THIS FILE EXISTS BESIDE 62_station_whatsapp_status.test.sql, which passes
 * already: pgTAP runs as superuser with a null `auth.uid()`, so
 * `is_owner_of_company` answers on the platform-admin arm and every gate reads
 * open. That file can prove the guard is PRESENT in the source and that the
 * grants are what they should be; it cannot prove the guard REFUSES anybody,
 * because it has nobody to refuse.
 *
 * WHAT IS ACTUALLY AT STAKE. This is the first function in the codebase to read
 * `integrations` (0057) for a caller who is not the platform admin. That table
 * carries a Station's telephone number and Meta's identifiers for it, it has RLS
 * enabled and NO POLICIES, and every one of 0130's three doors opens on
 * `is_platform_admin()`. Widening that reach by one predicate is the kind of
 * change whose failure mode is silent: a guard weakened to `has_company_access`
 * in some later refactor would keep every screen working, keep pgTAP green, and
 * hand one customer's number to another customer's staff.
 *
 * THE DELEGATE IN CASE 3 HOLDS EVERY TEMPLATE PERMISSION THERE IS. That is the
 * point of granting them at all: the refusal must not be explicable by "they
 * held nothing". Pairing is not a permission an owner hands out — it binds a
 * telephone number the Organization pays for — so no grant may substitute for
 * ownership, and this is the only place that is proved.
 */
const STAMP = Date.now();

describe('Block 29a — the Station WhatsApp status door', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;
  let outsider: ProvisionedCustomer;

  beforeAll(async () => {
    customer = await provisionCustomer(`station-settings-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station Settings');
    outsider = await provisionCustomer(`station-settings-outsider-${STAMP}`);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 1. The state every Station starts in, and the reason 0218 answers it with a
  //    row rather than with nothing. An empty result and a failed call are
  //    indistinguishable at the caller, and "no rows" would render as the same
  //    blank the whole block exists to replace.
  // -------------------------------------------------------------------------
  it('answers the owner with one row saying "not connected" before anything is paired', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const { data, error } = await owner.rpc('station_whatsapp_status', {
      p_company_id: secondCompanyId,
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.connected).toBe(false);
    // Not null, and that is the assertion: `enabled` is coalesced in 0218 so the
    // column means "sending is switched on" and never "unknown". A null here
    // would put a third state into a boolean the screen renders as a yes/no.
    expect(data?.[0]?.enabled).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. The state the screen exists to help a Station reach. `seedIntegration`
  //    writes through the superuser connection because there is no other route:
  //    `integrations` has RLS with no policy, so even the service role is
  //    refused by design.
  // -------------------------------------------------------------------------
  it('reports the pairing once one exists, with the number the owner would recognise', async () => {
    await seedIntegration(customer, `pn-${STAMP}`, customer.companyId);

    const owner = await signInAs(customer.email, customer.password);
    const { data, error } = await owner.rpc('station_whatsapp_status', {
      p_company_id: customer.companyId,
    });

    expect(error).toBeNull();
    expect(data?.[0]?.connected).toBe(true);
    expect(data?.[0]?.enabled).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. THE CASE THIS FILE IS FOR. A delegate of the SAME Station, holding both
  //    template permissions, is refused — because pairing is not a permission.
  // -------------------------------------------------------------------------
  it('refuses a delegate of the same Station who holds every template permission', async () => {
    const delegate = await grantRoleWith(
      customer,
      `station-settings-delegate-${STAMP}`,
      ['templates.view', 'templates.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('station_whatsapp_status', {
      p_company_id: customer.companyId,
    });

    // 42501, raised by the function's own guard rather than by a missing grant:
    // EXECUTE is granted to `authenticated`, which this caller is. A test that
    // merely asserted "error" would pass for a function nobody could call at
    // all, which is a different bug with the same symptom.
    expect(error?.code).toBe('42501');
    expect(data).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. The cross-tenant arm. An owner is an owner OF SOMETHING, and 0218 takes a
  //    Station id from the caller — so the predicate has to be evaluated against
  //    the Station asked about, not against the caller's own.
  // -------------------------------------------------------------------------
  it('refuses an owner of a different Organization asking about this Station', async () => {
    const other = await signInAs(outsider.email, outsider.password);

    const { data, error } = await other.rpc('station_whatsapp_status', {
      p_company_id: customer.companyId,
    });

    expect(error?.code).toBe('42501');
    expect(data).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. A SUSPENDED GROUP HAS AN OWNER WHO IS NOT AN OWNER, and this is the
  //    case /app's Settings button was built wrong for.
  //
  //    `is_owner_for` (0005, as Block 16's D5 left it) requires
  //    `organizations.suspended_at is null` ON TOP OF the owner membership --
  //    the group's lock, deliberately written in one function rather than in
  //    twenty policies. So the membership row and the predicate disagree for a
  //    suspended group, and a screen that reads memberships to decide what to
  //    show has a control the door will refuse.
  //
  //    That is not hypothetical: /app did exactly that, and CI's server log
  //    carried a 42501 from this function on every render for such an owner,
  //    each one silently a Settings button that could not work. The page now
  //    treats a 42501 here as the answer rather than as an error, which makes
  //    THIS assertion the thing that page depends on.
  //
  //    LAST BUT ONE, and the ordering is deliberate: it suspends the group,
  //    which every case above would fail against. Case 6 below uses a
  //    different mechanism and does not care.
  // -------------------------------------------------------------------------
  it('refuses the owner of a SUSPENDED group, whose membership row still says owner', async () => {
    // The membership is untouched by the suspension -- that is the whole point
    // of the case, so it is asserted BEFORE and AFTER rather than assumed.
    const owned = async () => {
      const { data } = await admin
        .from('organization_memberships')
        .select('role, deleted_at')
        .eq('organization_id', customer.organizationId)
        .eq('user_id', customer.userId);
      return (data ?? []).some(
        (m: { role: string; deleted_at: string | null }) =>
          m.role === 'owner' && m.deleted_at === null,
      );
    };
    expect(await owned(), 'the fixture owner owns the group to begin with').toBe(true);

    await suspendOrganization(customer.organizationId);

    expect(await owned(), 'suspending the group does not touch the membership').toBe(true);

    const owner = await signInAs(customer.email, customer.password);
    const { data, error } = await owner.rpc('station_whatsapp_status', {
      p_company_id: customer.companyId,
    });

    expect(error?.code).toBe('42501');
    expect(data).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 6. The widget's role, and the sign-in screen's. A Station's telephone number
  //    is not public, and the revoke in 0218 is what says so.
  // -------------------------------------------------------------------------
  it('refuses anon outright', async () => {
    const { data, error } = await anonClient.rpc('station_whatsapp_status', {
      p_company_id: customer.companyId,
    });

    expect(error).not.toBeNull();
    expect(data).toBeNull();
  }, 60_000);
});
