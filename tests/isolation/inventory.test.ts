import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  addMemberByInvitation,
  admin,
  cleanupUsers,
  corruptBalanceDirectly,
  createPrizeAs,
  createRoleAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

// Every RPC gated in 0027/0028 is a SECURITY DEFINER body reading auth.uid();
// pgTAP runs as superuser with no session user and cannot exercise that at
// all. This suite is the only place these claims are backed by a real JWT
// instead of by reading the SQL. Per the brief: the actor is a non-owner
// delegate holding a composed role in every case except where the owner is
// explicitly the subject — Block 1c shipped two defects that thirteen
// reviews missed because every scenario had the owner driving, and the
// owner's bypass hid the delegate's failure.
describe('inventory', () => {
  it('a movement cannot drive a bucket below zero — the RPC names the available count, not a bare constraint error', async () => {
    const label = `inv-floor-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Floor Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.entry', 'inventory.reserve']);
    const client = await signInAs(delegate.email, delegate.password);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 5,
    });
    expect(entry.error).toBeNull();

    const over = await client.rpc('reserve_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 10,
      p_note: 'holding for a promo',
    });

    expect(over.error).not.toBeNull();
    expect(over.error!.message).toMatch(/only 5 unit\(s\) are in available, and 10 were requested/);
    // The CHECK constraint on inventory_balances would also refuse this, but
    // with a bare constraint-name error — apply_inventory_movement's own
    // sufficiency check must be what actually fires here.
    expect(over.error!.message).not.toMatch(/violates check constraint/i);
  });

  describe('each operation is refused without its permission and allowed with it', () => {
    it('inventory.view gates reconcile_inventory', async () => {
      const label = `inv-perm-view-${Date.now()}`;
      const customer = await provisionCustomer(label);
      await createPrizeAs(customer, `Prize ${label}`);
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withView = await grantRoleWith(customer, `${label}-yes`, ['inventory.view']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('reconcile_inventory', {
        p_company_id: customer.companyId,
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.view required');

      const allowedClient = await signInAs(withView.email, withView.password);
      const allowed = await allowedClient.rpc('reconcile_inventory', {
        p_company_id: customer.companyId,
      });
      expect(allowed.error).toBeNull();
    });

    it('inventory.catalogue gates create_prize', async () => {
      const label = `inv-perm-catalogue-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withCatalogue = await grantRoleWith(customer, `${label}-yes`, ['inventory.catalogue']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('create_prize', {
        p_company_id: customer.companyId,
        p_name: 'Nope',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.catalogue required');

      const allowedClient = await signInAs(withCatalogue.email, withCatalogue.password);
      const allowed = await allowedClient.rpc('create_prize', {
        p_company_id: customer.companyId,
        p_name: 'Yes',
      });
      expect(allowed.error).toBeNull();
      expect(allowed.data).toBeTruthy();
    });

    it('inventory.entry gates record_stock_entry', async () => {
      const label = `inv-perm-entry-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withEntry = await grantRoleWith(customer, `${label}-yes`, ['inventory.entry']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 3,
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.entry required');

      const allowedClient = await signInAs(withEntry.email, withEntry.password);
      const allowed = await allowedClient.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 3,
      });
      expect(allowed.error).toBeNull();
    });

    it('inventory.exit gates record_stock_exit', async () => {
      const label = `inv-perm-exit-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      // Seeded by the owner: this case is about the exit gate, not the entry
      // one, which the pair above already covers.
      const owner = await signInAs(customer.email, customer.password);
      const seed = await owner.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 10,
      });
      expect(seed.error).toBeNull();

      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withExit = await grantRoleWith(customer, `${label}-yes`, ['inventory.exit']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('record_stock_exit', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 2,
        p_note: 'damaged',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.exit required');

      const allowedClient = await signInAs(withExit.email, withExit.password);
      const allowed = await allowedClient.rpc('record_stock_exit', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 2,
        p_note: 'damaged',
      });
      expect(allowed.error).toBeNull();
    });

    it('inventory.adjust gates adjust_stock', async () => {
      const label = `inv-perm-adjust-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const owner = await signInAs(customer.email, customer.password);
      const seed = await owner.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 5,
      });
      expect(seed.error).toBeNull();

      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withAdjust = await grantRoleWith(customer, `${label}-yes`, ['inventory.adjust']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 8,
        p_note: 'recount',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.adjust required');

      const allowedClient = await signInAs(withAdjust.email, withAdjust.password);
      const allowed = await allowedClient.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 8,
        p_note: 'recount',
      });
      expect(allowed.error).toBeNull();
    });

    it('inventory.reserve gates reserve_stock', async () => {
      const label = `inv-perm-reserve-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const owner = await signInAs(customer.email, customer.password);
      const seed = await owner.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 5,
      });
      expect(seed.error).toBeNull();

      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withReserve = await grantRoleWith(customer, `${label}-yes`, ['inventory.reserve']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('reserve_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 2,
        p_note: 'promo hold',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.reserve required');

      const allowedClient = await signInAs(withReserve.email, withReserve.password);
      const allowed = await allowedClient.rpc('reserve_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 2,
        p_note: 'promo hold',
      });
      expect(allowed.error).toBeNull();
    });

    it('a delegate holding every code except inventory.adjust is refused adjust_stock alone', async () => {
      const label = `inv-perm-allbutadjust-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const delegate = await grantRoleWith(customer, label, [
        'inventory.view',
        'inventory.catalogue',
        'inventory.entry',
        'inventory.exit',
        'inventory.reserve',
      ]);
      const client = await signInAs(delegate.email, delegate.password);

      // Proves this is not a general lockout: the very same delegate, same
      // client, can still add stock — the one write capability this test
      // grants alongside the one it withholds.
      const entry = await client.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 6,
      });
      expect(entry.error).toBeNull();

      const denied = await client.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 9,
        p_note: 'recount',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: inventory.adjust required');
    });
  });

  it('a replayed idempotency_key yields one movement and returns the same id', async () => {
    const label = `inv-idem-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    const key = `replay-${Date.now()}`;
    const first = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 7,
      p_idempotency_key: key,
    });
    expect(first.error).toBeNull();

    // A different quantity on the replay: if the replay were not actually
    // detected, this would silently record a SECOND movement with quantity 99
    // rather than returning the original untouched.
    const second = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 99,
      p_idempotency_key: key,
    });
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: rows, error } = await admin
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);

    const { data: balance } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId)
      .single();
    expect(balance?.available).toBe(7);
  });

  it('inventory.entry held in Station A does not act in Station B — refused by the role, not the access gate', async () => {
    const label = `inv-scope-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const stationB = await addCompany(customer, 'Station Two');

    const entryRole = await createRoleAs(customer, `Entry-${label}`, ['inventory.entry']);
    const bystanderRole = await createRoleAs(customer, `Bystander-${label}`, []);
    const delegate = await addMemberByInvitation(customer, label, entryRole, [customer.companyId]);

    // A LIVE membership in Station B under a role granting nothing. Without
    // this, has_company_access would already return false there and
    // has_permission would short-circuit before the role branch ever runs —
    // the same correction Block 1c's headline test needed, and exactly what
    // would leave this test passing at the access gate instead of the layer
    // it names.
    const owner = await signInAs(customer.email, customer.password);
    const { error: assignError } = await owner.rpc('assign_company_role', {
      p_company_id: stationB,
      p_user_id: delegate.userId,
      p_role_id: bystanderRole,
    });
    expect(assignError).toBeNull();

    const prizeInB = await createPrizeAs(customer, `Prize B ${label}`, stationB);
    const client = await signInAs(delegate.email, delegate.password);

    const { data: reachesB } = await client.rpc('has_company_access', { p_company_id: stationB });
    expect(reachesB).toBe(true);

    const denied = await client.rpc('record_stock_entry', {
      p_company_id: stationB,
      p_prize_id: prizeInB,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 4,
    });
    expect(denied.error).not.toBeNull();
    expect(denied.error!.message).toContain('permission denied: inventory.entry required');

    // Positive control: the same client still holds inventory.entry back in
    // Station A, so the refusal above is scope, not a broken grant.
    const prizeInA = await createPrizeAs(customer, `Prize A ${label}`, customer.companyId);
    const allowed = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeInA,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 4,
    });
    expect(allowed.error).toBeNull();
  });

  it('reconciliation reports nothing after real movements, and the exact divergence after a balance is corrupted directly', async () => {
    const label = `inv-recon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.entry',
      'inventory.reserve',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 10,
    });
    expect(entry.error).toBeNull();

    const reserve = await client.rpc('reserve_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 3,
      p_note: 'promo hold',
    });
    expect(reserve.error).toBeNull();

    const clean = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(clean.error).toBeNull();
    expect(clean.data).toEqual([]);

    // Corrupt "available" directly, entirely outside apply_inventory_movement
    // — see corruptBalanceDirectly's comment for why this is the only route
    // left, given 0029 revokes every write grant on this table from every
    // role, service_role included.
    corruptBalanceDirectly(customer.companyId, prizeId, 'available', 4);

    const dirty = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(dirty.error).toBeNull();
    expect(dirty.data).toHaveLength(1);
    expect(dirty.data![0]).toMatchObject({
      prize_id: prizeId,
      bucket: 'available',
      stored: 11,
      computed: 7,
    });
  });

  it('archiving a prize with stock is refused, naming the count; archiving one without stock succeeds', async () => {
    const label = `inv-archive-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['inventory.catalogue', 'inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    const stocked = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Stocked ${label}`,
    });
    expect(stocked.error).toBeNull();
    const stockedId = stocked.data as string;

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: stockedId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 5,
    });
    expect(entry.error).toBeNull();

    const refused = await client.rpc('archive_prize', { p_prize_id: stockedId });
    expect(refused.error).not.toBeNull();
    expect(refused.error!.message).toMatch(/this prize still has 5 unit\(s\) in stock/);

    const empty = await client.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Empty ${label}`,
    });
    expect(empty.error).toBeNull();
    const emptyId = empty.data as string;

    const succeeded = await client.rpc('archive_prize', { p_prize_id: emptyId });
    expect(succeeded.error).toBeNull();

    const { data: row } = await admin
      .from('prizes')
      .select('deleted_at')
      .eq('id', emptyId)
      .single();
    expect(row?.deleted_at).not.toBeNull();
  });

  it('adjust_stock with a count equal to the current figure records no movement', async () => {
    const label = `inv-noop-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.entry', 'inventory.adjust']);
    const client = await signInAs(delegate.email, delegate.password);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 6,
    });
    expect(entry.error).toBeNull();

    const { data: before } = await admin
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId);
    const countBefore = before?.length ?? 0;

    const noop = await client.rpc('adjust_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_counted: 6,
      p_note: 'shelf count matches',
    });
    expect(noop.error).toBeNull();
    expect(noop.data).toBeNull();

    const { data: after } = await admin
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId);
    expect(after?.length ?? 0).toBe(countBefore);

    const { data: balance } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId)
      .single();
    expect(balance?.available).toBe(6);
  });

  it('the ledger cannot be updated or deleted, with a real JWT nor with the service client', async () => {
    const label = `inv-immutable-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 4,
    });
    expect(entry.error).toBeNull();
    const movementId = entry.data as string;

    const jwtUpdate = await client
      .from('inventory_movements')
      .update({ quantity: 999 })
      .eq('id', movementId);
    expect(jwtUpdate.error).not.toBeNull();

    const jwtDelete = await client.from('inventory_movements').delete().eq('id', movementId);
    expect(jwtDelete.error).not.toBeNull();

    const serviceUpdate = await admin
      .from('inventory_movements')
      .update({ quantity: 999 })
      .eq('id', movementId);
    expect(serviceUpdate.error).not.toBeNull();

    const serviceDelete = await admin.from('inventory_movements').delete().eq('id', movementId);
    expect(serviceDelete.error).not.toBeNull();

    // Confirm nothing actually moved despite all four attempts.
    const { data: row } = await admin
      .from('inventory_movements')
      .select('quantity')
      .eq('id', movementId)
      .single();
    expect(row?.quantity).toBe(4);
  });
});
