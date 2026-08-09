import { describe, it, expect, afterAll } from 'vitest';
import { addCompany, admin, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

/**
 * Block 16, design D5. Blocking a customer group.
 *
 * WHY THIS FILE EXISTS AT ALL. 37_organization_blocking.test.sql asserts the
 * SHAPE — that the two doors exist and are gated — and it cannot assert the
 * behaviour, because pgTAP runs as superuser with a null auth.uid() where RLS
 * never applies and every helper answers about a session that is not there.
 * Whether a block actually stops anybody is a question only a real second
 * identity can answer.
 *
 * WHAT IT IS BUILT TO CATCH, and the reason the spec called it the block's most
 * important test: a version of this that checks only the MEMBER passes against
 * the exact defect D5 warns about. Staff reach a Station through
 * company_memberships and therefore through has_company_access_for; the OWNER
 * reaches it through is_owner_for, which checked no status of any kind before
 * 0156. A block written into one and not the other stops the staff and leaves
 * the owner — the one person a blocked customer most needs to stop — browsing.
 *
 * So every assertion below is made twice, once as each identity, and the
 * owner's half is the half that matters.
 */

afterAll(async () => {
  await cleanupUsers();
});

describe('blocking an Organization', () => {
  it('refuses the owner and the staff alike, across every Station, and releases both', async () => {
    const customer = await provisionCustomer(`block-${Date.now()}`);
    // TWO Stations, because a block that only reached the Station a test happens
    // to name would pass a one-Station fixture and leave the second radio open.
    const secondCompanyId = await addCompany(customer, `Second ${Date.now()}`);

    const staff = await grantRoleWith(customer, `blockstaff-${Date.now()}`, ['members.view'], [
      customer.companyId,
      secondCompanyId,
    ]);

    const ownerClient = await signInAs(customer.email, customer.password);
    const staffClient = await signInAs(staff.email, staff.password);

    // A row on an Organization-scoped table. `members` policies call
    // public.is_owner(organization_id) DIRECTLY and never touch
    // has_company_access — the third shape 0156's audit turned up, and the
    // reason the condition went into is_owner_for rather than into a list of
    // policies somebody would have to keep complete.
    //
    // Through the real RPC, not an insert: 0035 revokes every write grant on
    // this table from every role, service_role included, so create_member is the
    // only way a row gets here at all.
    const { error: seedError } = await ownerClient.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Blocked group listener ${Date.now()}`,
    });
    expect(seedError).toBeNull();

    // ---------------------------------------------------------------------
    // Before the block: both identities reach both Stations.
    // ---------------------------------------------------------------------
    expect(await accessTo(ownerClient, customer.companyId)).toBe(true);
    expect(await accessTo(ownerClient, secondCompanyId)).toBe(true);
    expect(await accessTo(staffClient, customer.companyId)).toBe(true);
    expect(await accessTo(staffClient, secondCompanyId)).toBe(true);

    // The owner's OWN door, the one that checked nothing before 0156.
    expect(await ownsCompany(ownerClient, customer.companyId)).toBe(true);
    expect(await ownsCompany(ownerClient, secondCompanyId)).toBe(true);

    // And the Organization-scoped path, which reaches neither of the two above.
    expect(await ownsOrganization(ownerClient, customer.organizationId)).toBe(true);
    expect(await countMembers(ownerClient)).toBe(1);

    // ---------------------------------------------------------------------
    // The block.
    // ---------------------------------------------------------------------
    const { error: blockError } = await customer.adminClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: 'non-payment',
    });
    expect(blockError).toBeNull();

    // ---------------------------------------------------------------------
    // After it: everything above is false, for BOTH identities and BOTH
    // Stations.
    // ---------------------------------------------------------------------
    expect(await accessTo(staffClient, customer.companyId)).toBe(false);
    expect(await accessTo(staffClient, secondCompanyId)).toBe(false);

    // THE FOUR ASSERTIONS THIS FILE WAS WRITTEN FOR. Delete these and the test
    // still passes against a build where blocking leaves the owner with the run
    // of the customer's whole account.
    expect(await accessTo(ownerClient, customer.companyId)).toBe(false);
    expect(await accessTo(ownerClient, secondCompanyId)).toBe(false);
    expect(await ownsCompany(ownerClient, customer.companyId)).toBe(false);
    expect(await ownsCompany(ownerClient, secondCompanyId)).toBe(false);

    // The third shape: the audience is Organization-scoped, so nothing about it
    // passes through either door above.
    expect(await ownsOrganization(ownerClient, customer.organizationId)).toBe(false);
    expect(await countMembers(ownerClient)).toBe(0);

    // THE ONE THING A BLOCK DELIBERATELY DOES NOT TAKE AWAY, asserted so that
    // nobody tidies it into consistency later: the owner still SEES their
    // Stations. 0156 keeps one named caller of the pure ownership question for
    // exactly this — a screen that says "no station is linked to your account"
    // to somebody who has two is a screen that lies, and it turns a billing
    // conversation into a support incident.
    const { data: visible } = await ownerClient.from('companies').select('id').eq(
      'organization_id',
      customer.organizationId,
    );
    expect(visible?.length ?? 0).toBe(2);

    // The staff, who reach companies through their membership and not through
    // ownership, keep seeing them too — is_company_member is the third branch of
    // that same policy and carries no lock. What neither of them can do is
    // anything else, which is what every assertion above measures.

    // The platform admin is deliberately outside the condition: whoever blocked
    // the group has to be able to look at it and release it, or the console
    // locks itself out of the customer it just locked.
    expect(await accessTo(customer.adminClient, customer.companyId)).toBe(true);

    // ---------------------------------------------------------------------
    // The release.
    // ---------------------------------------------------------------------
    const { error: unblockError } = await customer.adminClient.rpc('unblock_organization', {
      p_organization_id: customer.organizationId,
    });
    expect(unblockError).toBeNull();

    expect(await accessTo(ownerClient, customer.companyId)).toBe(true);
    expect(await accessTo(ownerClient, secondCompanyId)).toBe(true);
    expect(await accessTo(staffClient, customer.companyId)).toBe(true);
    expect(await accessTo(staffClient, secondCompanyId)).toBe(true);
    expect(await ownsCompany(ownerClient, customer.companyId)).toBe(true);
    expect(await ownsOrganization(ownerClient, customer.organizationId)).toBe(true);
    expect(await countMembers(ownerClient)).toBe(1);
  });

  it('takes effect without signing anybody out, on the very next request', async () => {
    const customer = await provisionCustomer(`blocklive-${Date.now()}`);

    // Signed in BEFORE the block and never signed in again: the same client,
    // holding the same JWT it was issued. This is the property the console's
    // confirmation sentence promises, and it holds because the RLS helpers query
    // these tables on every check rather than reading anything off the token.
    const ownerClient = await signInAs(customer.email, customer.password);
    expect(await accessTo(ownerClient, customer.companyId)).toBe(true);

    await customer.adminClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: 'non-payment',
    });

    expect(await accessTo(ownerClient, customer.companyId)).toBe(false);
  });

  it('refuses a block with no reason, and is silent about one already blocked', async () => {
    const customer = await provisionCustomer(`blockreason-${Date.now()}`);

    // A reason is required because somebody will be asked why, possibly months
    // later, and this is the heaviest control in the console.
    const { error: blank } = await customer.adminClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: '   ',
    });
    expect(blank?.code).toBe('22023');

    await customer.adminClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: 'non-payment',
    });

    // Silent on the second call: a console that double-submits must not produce
    // an error somebody investigates, and blocking twice is not a failure by any
    // reading.
    const { error: again } = await customer.adminClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: 'non-payment',
    });
    expect(again).toBeNull();

    // Releasing clears the reason with the lock. A reason left behind would read
    // as a live block on the next screen that showed it.
    await customer.adminClient.rpc('unblock_organization', {
      p_organization_id: customer.organizationId,
    });
    const { data } = await admin
      .from('organizations')
      .select('suspended_at, suspended_by, suspension_reason')
      .eq('id', customer.organizationId)
      .single();
    expect(data?.suspended_at).toBeNull();
    expect(data?.suspended_by).toBeNull();
    expect(data?.suspension_reason).toBeNull();
  });

  it('is refused to anyone who is not a platform admin', async () => {
    const customer = await provisionCustomer(`blockgate-${Date.now()}`);
    const ownerClient = await signInAs(customer.email, customer.password);

    // The owner is the most privileged customer identity there is, and the one
    // with the clearest motive to release their own block.
    const { error: blocked } = await ownerClient.rpc('block_organization', {
      p_organization_id: customer.organizationId,
      p_reason: 'let me out',
    });
    expect(blocked?.code).toBe('42501');

    const { error: released } = await ownerClient.rpc('unblock_organization', {
      p_organization_id: customer.organizationId,
    });
    expect(released?.code).toBe('42501');
  });
});

/** The membership path: has_company_access_for, which every permission ANDs. */
async function accessTo(
  client: Awaited<ReturnType<typeof signInAs>>,
  companyId: string,
): Promise<boolean | null> {
  const { data } = await client.rpc('has_company_access', { p_company_id: companyId });
  return data;
}

/**
 * The owner's own path: is_owner_of_company, which 0044's policies admit the
 * owner through to rows everyone else is denied, and which checked no status of
 * any kind before 0156.
 */
async function ownsCompany(
  client: Awaited<ReturnType<typeof signInAs>>,
  companyId: string,
): Promise<boolean | null> {
  const { data } = await client.rpc('is_owner_of_company', { p_company_id: companyId });
  return data;
}

/** The Organization-scoped path, called directly by more than twenty policies. */
async function ownsOrganization(
  client: Awaited<ReturnType<typeof signInAs>>,
  organizationId: string,
): Promise<boolean | null> {
  const { data } = await client.rpc('is_owner', { p_organization_id: organizationId });
  return data;
}

async function countMembers(client: Awaited<ReturnType<typeof signInAs>>): Promise<number> {
  const { data } = await client.from('members').select('id');
  return data?.length ?? 0;
}
