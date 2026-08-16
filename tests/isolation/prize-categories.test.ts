import { afterAll, describe, expect, it } from 'vitest';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 26. What pgTAP cannot reach.
 *
 * `56_prize_categories.test.sql` proves the two doors against a session it sets
 * by hand. This suite drives them through a REAL JWT, a real role and a real
 * membership, which is the only way the cross-Station claims are actually tested:
 * `has_permission` reads `auth.uid()`, and the separation between two Stations of
 * one Organization only exists once there are two Stations and a caller who
 * belongs to both.
 *
 * Per this directory's standing rule, the actor is a non-owner DELEGATE in every
 * case: Block 1c shipped two defects that thirteen reviews missed because every
 * scenario had the owner driving, and the owner's bypass hid the delegate's
 * failure.
 */
describe('prize categories', () => {
  it('a category of one Station is invisible from another, inside the same Organization', async () => {
    const label = `category-isolation-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // The delegate holds the permissions in BOTH Stations, so what separates them
    // below is the row's own company_id rather than a missing grant.
    const delegate = await grantRoleWith(
      customer,
      label,
      ['inventory.view', 'inventory.catalogue'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Camisetas ${label}`,
    });
    expect(created.error).toBeNull();

    const here = await client
      .from('prize_categories')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);

    const there = await client
      .from('prize_categories')
      .select('id')
      .eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding inventory.view alone, and writes nothing', async () => {
    const label = `category-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['inventory.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: 'Categoria proibida',
    });

    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.message).toMatch(/inventory\.catalogue required/);

    // A refusal that half-lands is worse than one that does not land at all.
    const rows = await client
      .from('prize_categories')
      .select('id')
      .eq('company_id', customer.companyId);
    expect(rows.data).toHaveLength(0);
  });

  it('refuses to rename another Station’s category, even holding the permission in both', async () => {
    const label = `category-cross-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    const delegate = await grantRoleWith(
      customer,
      label,
      ['inventory.view', 'inventory.catalogue'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const foreign = await client.rpc('save_prize_category', {
      p_company_id: otherCompanyId,
      p_name: `Canecas B ${label}`,
    });
    expect(foreign.error).toBeNull();

    // The permission is held at Station A, and the id belongs to Station B. The
    // door's own `company_id` in the WHERE is the only thing standing between
    // those two facts — which is exactly why this case exists.
    const hijack = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: 'Sequestrada',
      p_category_id: foreign.data as string,
    });
    expect(hijack.error).not.toBeNull();
    expect(hijack.error!.message).toMatch(/category not found/);

    // And the row is untouched, read from the Station it actually belongs to.
    const still = await client
      .from('prize_categories')
      .select('name')
      .eq('id', foreign.data as string)
      .single();
    expect(still.data?.name).toBe(`Canecas B ${label}`);
  });

  it('archiving takes the label off the prizes wearing it, and reports how many', async () => {
    const label = `category-archive-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.catalogue',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Camisetas ${label}`,
    });
    expect(created.error).toBeNull();
    const categoryId = created.data as string;

    // Registered through the real door, as the delegate, wearing the label.
    const prizeIds: string[] = [];
    for (const name of [`Camiseta P ${label}`, `Camiseta M ${label}`]) {
      const prize = await client.rpc('create_prize', {
        p_company_id: customer.companyId,
        p_name: name,
        p_category_id: categoryId,
      });
      expect(prize.error).toBeNull();
      prizeIds.push(prize.data as string);
    }

    // A prize in NO category, to prove the door's WHERE narrows to the label
    // rather than sweeping the Station.
    const untouched = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Sem categoria ${label}`,
    });
    expect(untouched.error).toBeNull();

    const archived = await client.rpc('archive_prize_category', { p_category_id: categoryId });
    expect(archived.error).toBeNull();
    // The count the confirmation dialog quotes back to the operator.
    expect(archived.data).toBe(2);

    const prizes = await client
      .from('prizes')
      .select('id,category_id')
      .in('id', [...prizeIds, untouched.data as string]);
    expect(prizes.error).toBeNull();
    expect(prizes.data).toHaveLength(3);
    for (const row of prizes.data ?? []) expect(row.category_id).toBeNull();

    // The category itself is gone from every ordinary read, not merely filtered
    // out client-side: 0029's select policy carries `deleted_at is null`.
    const gone = await client.from('prize_categories').select('id').eq('id', categoryId);
    expect(gone.data).toHaveLength(0);
  });

  it('scopes the name to the Station, and frees it again on archive', async () => {
    const label = `category-name-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    const delegate = await grantRoleWith(
      customer,
      label,
      ['inventory.view', 'inventory.catalogue'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const first = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: 'Camisetas',
    });
    expect(first.error).toBeNull();

    // Case-insensitive, and the door says so in words rather than naming an index.
    const twin = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: 'camisetas',
    });
    expect(twin.error).not.toBeNull();
    expect(twin.error!.message).toMatch(/already exists in this station/);

    // The same word at another Station is a different grouping entirely.
    const elsewhere = await client.rpc('save_prize_category', {
      p_company_id: otherCompanyId,
      p_name: 'Camisetas',
    });
    expect(elsewhere.error).toBeNull();

    const archived = await client.rpc('archive_prize_category', {
      p_category_id: first.data as string,
    });
    expect(archived.error).toBeNull();
    // Nothing wore it, so nothing was detached — the operator is told that rather
    // than shown a number they have to interpret.
    expect(archived.data).toBe(0);

    const again = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: 'Camisetas',
    });
    expect(again.error).toBeNull();
    expect(again.data).not.toBe(first.data);
  });

  /**
   * THE ONLY PLACE THE PRIZES COLUMN IS PROVED AGAINST A REAL PostgREST.
   *
   * `listPrizeCategoriesPage` reads the count through an embedded aggregate —
   * `prize_categories?select=...,prizes(count)` — and it is the first one in this
   * codebase. Every other list counts with `count: 'exact', head: true`, which is
   * a header rather than a select, so nothing else here would notice if PostgREST
   * were ever served with aggregate functions disabled: the answer to that is a
   * 400 on the whole screen, not a missing column.
   *
   * The e2e drives the rendered number, which is the same claim from further
   * away; this asserts the SHAPE the service parses (`prizes[0].count`) and that
   * the embedded `deleted_at` filter narrows the embed rather than the rows —
   * a category with nothing live in it has to come back with a zero, not vanish.
   */
  it('counts the live prizes per category through the embed the list reads', async () => {
    const label = `category-count-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.catalogue',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const worn = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Com prêmios ${label}`,
    });
    const bare = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Sem prêmios ${label}`,
    });
    expect(worn.error).toBeNull();
    expect(bare.error).toBeNull();

    const kept = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Vivo ${label}`,
      p_category_id: worn.data as string,
    });
    expect(kept.error).toBeNull();

    const archivedPrize = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Arquivado ${label}`,
      p_category_id: worn.data as string,
    });
    expect(archivedPrize.error).toBeNull();
    expect((await client.rpc('archive_prize', { p_prize_id: archivedPrize.data as string })).error)
      .toBeNull();

    // The same select the service builds, spelled out here because that module is
    // `server-only` and cannot be imported from this suite. If one changes, this
    // is the test that has to change with it.
    const read = await client
      .from('prize_categories')
      .select('id, company_id, name, created_at, prizes(count)')
      .eq('company_id', customer.companyId)
      .is('deleted_at', null)
      .is('prizes.deleted_at', null)
      .order('name');

    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(2);

    const byId = new Map(
      (read.data ?? []).map((row) => [
        row.id,
        (row.prizes as unknown as { count: number }[] | null)?.[0]?.count ?? 0,
      ]),
    );
    // One live prize, not two: the archived one is filtered by 0029's policy and
    // by the embedded filter both.
    expect(byId.get(worn.data as string)).toBe(1);
    // And the empty category is STILL A ROW. An `!inner` embed would have dropped
    // it, which on the screen reads as a category that does not exist.
    expect(byId.get(bare.data as string)).toBe(0);
  });

  it('renames in place rather than registering a second one', async () => {
    const label = `category-rename-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.catalogue',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Brindes ${label}`,
    });
    expect(created.error).toBeNull();

    const prize = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Caneca ${label}`,
      p_category_id: created.data as string,
    });
    expect(prize.error).toBeNull();

    const renamed = await client.rpc('save_prize_category', {
      p_company_id: customer.companyId,
      p_name: `Brindes do Norte ${label}`,
      p_category_id: created.data as string,
    });
    expect(renamed.error).toBeNull();
    expect(renamed.data).toBe(created.data);

    const rows = await client
      .from('prize_categories')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]?.name).toBe(`Brindes do Norte ${label}`);

    // A rename is not an archive: the prize keeps pointing at the same row and
    // simply starts reading the new word. This is the difference the record
    // dialog's own line promises an operator.
    const kept = await client
      .from('prizes')
      .select('category_id')
      .eq('id', prize.data as string)
      .single();
    expect(kept.data?.category_id).toBe(created.data);
  });
});
