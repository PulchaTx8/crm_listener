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

    // apply_inventory_movement appends the movement row BEFORE it checks
    // sufficiency (the sufficiency check reads the balance the insert has
    // already happened relative to), so only the statement's own rollback on
    // the raised exception stands between this and a phantom RESERVATION row
    // in the ledger. Only the earlier, successful MANUAL_ENTRY should survive.
    const { data: rows, error } = await admin
      .from('inventory_movements')
      .select('id, movement_type')
      .eq('prize_id', prizeId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.movement_type).toBe('MANUAL_ENTRY');
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

    // Corrupt "delivered" directly, entirely outside apply_inventory_movement
    // — see corruptBalanceDirectly's comment for why this is the only route
    // left, given 0029 revokes every write grant on this table from every
    // role, service_role included.
    //
    // "delivered" specifically, not "available": no movement in this test ever
    // names delivered as a from/to bucket, so the computed CTE in 0028 has NO
    // row at all for (prize, 'delivered') — it exists only on the stored side.
    // Corrupting "available" instead (which has rows on BOTH sides already,
    // stored 11 vs computed 7) would still pass even if the FULL OUTER JOIN
    // were degraded to an INNER JOIN, because an inner join keeps any key
    // present on both sides. Only a key present on one side alone — this one —
    // actually depends on the join being FULL OUTER rather than INNER.
    await corruptBalanceDirectly(customer.companyId, prizeId, 'delivered', 4);

    const dirty = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(dirty.error).toBeNull();
    expect(dirty.data).toHaveLength(1);
    expect(dirty.data![0]).toMatchObject({
      prize_id: prizeId,
      bucket: 'delivered',
      stored: 4,
      computed: 0,
    });
  });

  it('reconciliation still reports the per-prize divergence, and now says which promotion a row belongs to', async () => {
    const label = `inv-recon-shape-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.view', 'inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 6,
    });

    await corruptBalanceDirectly(customer.companyId, prizeId, 'written_off', 2);

    const dirty = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(dirty.error).toBeNull();
    expect(dirty.data).toHaveLength(1);

    // The two new columns are null on a per-prize row, and that is what tells
    // the two kinds of row apart on screen. Asserted explicitly rather than
    // left to toMatchObject, which would pass if they were missing entirely.
    expect(dirty.data![0]).toEqual({
      prize_id: prizeId,
      prize_name: `Prize ${label}`,
      promotion_prize_id: null,
      promotion_name: null,
      bucket: 'written_off',
      stored: 2,
      computed: 0,
    });
  });

  it('releases a reservation back into available, which is the fifth call site into the one writer', async () => {
    const label = `inv-release-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.entry',
      'inventory.reserve',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 9,
    });
    await client.rpc('reserve_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 4,
      p_note: 'held for the afternoon show',
    });

    const released = await client.rpc('release_reservation', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 3,
      p_note: 'show cancelled',
    });
    expect(released.error).toBeNull();

    const balance = await client
      .from('inventory_balances')
      .select('available, reserved')
      .eq('prize_id', prizeId)
      .single();
    expect(balance.data).toEqual({ available: 8, reserved: 1 });

    // What this proves: release_reservation actually reached the ledger, and
    // the projection it wrote agrees with the movements behind it.
    // reconcile_inventory recomputes available and reserved from
    // inventory_movements alone, so an empty result here says the three
    // movements this case appended and the two figures asserted just above are
    // the same arithmetic. That is what makes this a real net under the fifth
    // call site rather than a smoke test: a from/to bucket wired inconsistently
    // with the arithmetic, or a release that moved a different number of units
    // than it recorded, goes red here.
    //
    // What it does NOT prove, said plainly because it is the natural thing to
    // assume: that the call resolves to the nine-argument
    // apply_inventory_movement rather than to a stale eight-argument overload.
    // release_reservation passes no promotion reference, so both bodies would
    // write inventory_balances identically and reconciliation would stay clean
    // either way. That failure mode needs no net here — 0047 dropped the
    // eight-argument signature outright, so a call still expecting it fails
    // loudly at the call itself instead of quietly passing this assertion.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });

  it('archiving a prize with stock is refused, naming the count; archiving one without stock succeeds', async () => {
    const label = `inv-archive-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.catalogue',
      'inventory.entry',
      'inventory.reserve',
    ]);
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

    // Reserve the full quantity before archiving, so available = 0 and
    // reserved = 5: the refusal below can then only be explained by
    // archive_prize's physical-stock sum including the `reserved` bucket. If
    // the sum omitted `reserved` (or `linked`/`awaiting_pickup`/
    // `pending_return`), archiving would wrongly succeed here even though 5
    // units are still outstanding — the earlier version of this test, which
    // left the 5 units in `available`, could not have told that apart, since
    // `available` is the one bucket every plausible (correct or broken) sum
    // would still include.
    const reserve = await client.rpc('reserve_stock', {
      p_company_id: customer.companyId,
      p_prize_id: stockedId,
      p_quantity: 5,
      p_note: 'holding for a promo',
    });
    expect(reserve.error).toBeNull();

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

    // .single() with a bad/missing id would come back with row === undefined
    // AND an error — asserting the error is null first is what stops
    // `row?.deleted_at` (undefined) from vacuously satisfying `not.toBeNull()`.
    const { data: row, error: rowError } = await admin
      .from('prizes')
      .select('deleted_at')
      .eq('id', emptyId)
      .single();
    expect(rowError).toBeNull();
    expect(row?.deleted_at).toBeTruthy();
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

    const { data: before, error: beforeError } = await admin
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId);
    expect(beforeError).toBeNull();
    const countBefore = before?.length ?? 0;

    const noop = await client.rpc('adjust_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_counted: 6,
      p_note: 'shelf count matches',
    });
    expect(noop.error).toBeNull();
    expect(noop.data).toBeNull();

    // Asserting both reads' errors are null (not just comparing counts) is
    // what stops a failed second read (both sides silently 0) from passing
    // this assertion vacuously.
    const { data: after, error: afterError } = await admin
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId);
    expect(afterError).toBeNull();
    expect(after?.length ?? 0).toBe(countBefore);

    const { data: balance } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId)
      .single();
    expect(balance?.available).toBe(6);
  });

  // adjust_stock (0030 fix): p_counted is the PHYSICAL count — everything on
  // the shelf, reserved units included (design spec §4 puts reserved inside
  // the physical total; a reservation commits units, it does not remove them
  // from the Station). Before this fix, adjust_stock reconciled ONLY
  // `available` against `p_counted`, so an operator who correctly counted
  // the whole shelf while some of it was reserved would have their honest
  // count read as an increase to `available` alone — inventing units that
  // were never missing. These three cases pin the corrected contract.
  describe('adjust_stock reconciles the physical count, not available alone', () => {
    it('a physical count equal to available + reserved (+ every other committed bucket) records no movement and changes nothing', async () => {
      const label = `inv-physical-noop-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const delegate = await grantRoleWith(customer, label, [
        'inventory.entry',
        'inventory.reserve',
        'inventory.adjust',
      ]);
      const client = await signInAs(delegate.email, delegate.password);

      const entry = await client.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 40,
      });
      expect(entry.error).toBeNull();

      const reserve = await client.rpc('reserve_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 10,
        p_note: 'holding for a promo',
      });
      expect(reserve.error).toBeNull();

      // available 30, reserved 10 — physical total 40. Pre-fix, adjust_stock
      // would compute 40 - available(30) = +10 and invent an
      // ADJUSTMENT_POSITIVE of 10 units that were never missing (they were
      // sitting in `reserved` the whole time).
      const { data: before, error: beforeError } = await admin
        .from('inventory_movements')
        .select('id')
        .eq('prize_id', prizeId);
      expect(beforeError).toBeNull();
      const countBefore = before?.length ?? 0;

      const adjust = await client.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 40,
        p_note: 'shelf count matches the physical total',
      });
      expect(adjust.error).toBeNull();
      expect(adjust.data).toBeNull();

      const { data: after, error: afterError } = await admin
        .from('inventory_movements')
        .select('id')
        .eq('prize_id', prizeId);
      expect(afterError).toBeNull();
      expect(after?.length ?? 0).toBe(countBefore);

      const { data: balance, error: balanceError } = await admin
        .from('inventory_balances')
        .select('available, reserved')
        .eq('prize_id', prizeId)
        .single();
      expect(balanceError).toBeNull();
      expect(balance?.available).toBe(30);
      expect(balance?.reserved).toBe(10);
    });

    it('a genuinely different physical count moves only available, leaving reserved untouched', async () => {
      const label = `inv-physical-delta-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const delegate = await grantRoleWith(customer, label, [
        'inventory.entry',
        'inventory.reserve',
        'inventory.adjust',
      ]);
      const client = await signInAs(delegate.email, delegate.password);

      const entry = await client.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 40,
      });
      expect(entry.error).toBeNull();

      const reserve = await client.rpc('reserve_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 10,
        p_note: 'holding for a promo',
      });
      expect(reserve.error).toBeNull();

      // available 30, reserved 10, physical total 40. A genuine count of 45
      // means five more units physically exist than the ledger shows, none
      // of them reserved — the whole difference belongs to `available`.
      const adjust = await client.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 45,
        p_note: 'found five more on a top shelf',
      });
      expect(adjust.error).toBeNull();
      expect(adjust.data).toBeTruthy();

      const { data: movement, error: movementError } = await admin
        .from('inventory_movements')
        .select('movement_type, quantity, from_bucket, to_bucket')
        .eq('id', adjust.data as string)
        .single();
      expect(movementError).toBeNull();
      expect(movement).toMatchObject({
        movement_type: 'ADJUSTMENT_POSITIVE',
        quantity: 5,
        from_bucket: null,
        to_bucket: 'available',
      });

      const { data: balance, error: balanceError } = await admin
        .from('inventory_balances')
        .select('available, reserved')
        .eq('prize_id', prizeId)
        .single();
      expect(balanceError).toBeNull();
      expect(balance?.available).toBe(35);
      expect(balance?.reserved).toBe(10);
    });

    it('a physical count below what is already committed is refused, naming both figures', async () => {
      const label = `inv-physical-refuse-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const prizeId = await createPrizeAs(customer, `Prize ${label}`);
      const delegate = await grantRoleWith(customer, label, [
        'inventory.entry',
        'inventory.reserve',
        'inventory.adjust',
      ]);
      const client = await signInAs(delegate.email, delegate.password);

      const entry = await client.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: 40,
      });
      expect(entry.error).toBeNull();

      const reserve = await client.rpc('reserve_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_quantity: 10,
        p_note: 'holding for a promo',
      });
      expect(reserve.error).toBeNull();

      // committed = reserved(10) + linked(0) + awaiting_pickup(0) +
      // pending_return(0) = 10. A count of 5 claims fewer physical units
      // exist than are already promised to the reservation alone — a state
      // an adjustment cannot express.
      const refused = await client.rpc('adjust_stock', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_counted: 5,
        p_note: 'shelf recount',
      });
      expect(refused.error).not.toBeNull();
      expect(refused.error!.message).toMatch(
        /counted total 5 is less than the 10 unit\(s\) already committed/,
      );

      // Nothing moved: the refusal happens before any movement is appended.
      const { data: balance, error: balanceError } = await admin
        .from('inventory_balances')
        .select('available, reserved')
        .eq('prize_id', prizeId)
        .single();
      expect(balanceError).toBeNull();
      expect(balance?.available).toBe(30);
      expect(balance?.reserved).toBe(10);
    });
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

    // 42501 pinned on all four, not just "an error occurred": 0029 makes
    // permission-denied the only correct reason any of these can fail. A bare
    // not-null would pass identically for, say, a schema-cache miss on
    // `quantity` (a column a later block renamed) — a real failure, but not
    // this one, and not the one this case exists to prove.
    const jwtUpdate = await client
      .from('inventory_movements')
      .update({ quantity: 999 })
      .eq('id', movementId);
    expect(jwtUpdate.error?.code).toBe('42501');

    const jwtDelete = await client.from('inventory_movements').delete().eq('id', movementId);
    expect(jwtDelete.error?.code).toBe('42501');

    const serviceUpdate = await admin
      .from('inventory_movements')
      .update({ quantity: 999 })
      .eq('id', movementId);
    expect(serviceUpdate.error?.code).toBe('42501');

    const serviceDelete = await admin.from('inventory_movements').delete().eq('id', movementId);
    expect(serviceDelete.error?.code).toBe('42501');

    // Confirm nothing actually moved despite all four attempts.
    const { data: row } = await admin
      .from('inventory_movements')
      .select('quantity')
      .eq('id', movementId)
      .single();
    expect(row?.quantity).toBe(4);
  });
});
