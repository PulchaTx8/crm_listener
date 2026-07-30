import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createPrizeAs,
  grantRoleWith,
  provisionCustomer,
  setPromotionPrizeDrawnDirectly,
  signInAs,
} from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

/**
 * Block 4b's write RPCs, driven end to end.
 *
 * Every case is driven by a NON-OWNER delegate, for the reason members.test.ts's
 * own header gives: Block 1c shipped two defects that thirteen reviews missed
 * because every scenario had the owner driving, and the owner's bypass hid the
 * delegate's failure. The owner appears below only as fixture setup.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clientFor(user: { email: string; password: string }) {
  return signInAs(user.email, user.password);
}

/** A promotion inside its window, registered by the owner. Fixture, never the operation under test. */
async function promotionAsOwner(
  customer: ProvisionedCustomer,
  window: { startsAt: string; endsAt: string } = {
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  },
): Promise<string> {
  const owner = await clientFor(customer);
  const { data, error } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${Math.random().toString(36).slice(2, 8)}`,
    p_starts_at: window.startsAt,
    p_ends_at: window.endsAt,
  });
  if (error) throw new Error(`create_promotion failed: ${error.message}`);
  return data as string;
}

/** Puts `units` into `available` for a prize, as the owner. */
async function stockAsOwner(
  customer: ProvisionedCustomer,
  prizeId: string,
  units: number,
): Promise<void> {
  const owner = await clientFor(customer);
  const { error } = await owner.rpc('record_stock_entry', {
    p_company_id: customer.companyId,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: units,
  });
  if (error) throw new Error(`record_stock_entry failed: ${error.message}`);
}

describe('linking a prize to a promotion', () => {
  it('moves the units out of available and into the promotion, in one transaction', async () => {
    const label = `link-ok-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Bicycle ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 4,
    });
    expect(linked.error).toBeNull();
    const linkId = linked.data as string;

    const balance = await client
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', linkId)
      .single();
    expect(balance.data).toEqual({ linked: 4, drawn: 0 });

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 6, linked: 4 });
  });

  it('adds to the row that is there rather than creating a second one', async () => {
    const label = `link-again-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Headphones ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const first = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    const second = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(second.error).toBeNull();
    // The same link, not a second one — which is what the partial unique index
    // in 0045 guarantees and what makes "Vinculados" a single figure on screen.
    expect(second.data).toBe(first.data);

    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(1);

    const balance = await client
      .from('promotion_prize_balances')
      .select('linked')
      .eq('promotion_prize_id', first.data as string)
      .single();
    expect(balance.data?.linked).toBe(5);
  });

  it('is allowed after the window has closed, and refused once cancelled', async () => {
    const label = `link-ended-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Speaker ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    // Ends in a moment, so the window closes without anything being cancelled.
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      endsAt: new Date(Date.now() - HOUR).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    // The draw happens after entries close (Block 6), so an ended promotion is
    // exactly when its prizes are most likely to be adjusted. Not an oversight.
    const ended = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(ended.error).toBeNull();

    // The other half this case's name promises, and the only coverage the
    // cancelled_at refusal has. It needs a promotion of its own: cancel_promotion
    // (0042) refuses one whose window has already closed, so the ended promotion
    // above cannot be cancelled at all.
    const cancelledId = await promotionAsOwner(customer);
    const owner = await clientFor(customer);
    const { error: cancelError } = await owner.rpc('cancel_promotion', {
      p_promotion_id: cancelledId,
      p_reason: 'Prize supplier withdrew',
    });
    if (cancelError) throw new Error(`cancel_promotion failed: ${cancelError.message}`);

    const refused = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: cancelledId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(refused.error?.code).toBe('22023');
    // Cancelling is what hands the units back (Task 6), so committing more to a
    // cancelled promotion would strand them exactly where that rule exists to
    // stop them being stranded.
    expect(refused.error?.message).toContain('cancelled');
  });

  it('refuses more units than are available, naming the figure', async () => {
    const label = `link-short-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Ticket ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });
    expect(denied.error?.code).toBe('23514');
    expect(denied.error?.message).toContain('3');
  });

  it('refuses a non-positive quantity', async () => {
    const label = `link-zero-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Mug ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 0,
    });
    expect(denied.error?.code).toBe('22023');
  });

  it('refuses a prize from another Station', async () => {
    const label = `link-cross-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const foreignPrizeId = await createPrizeAs(customer, `Foreign ${label}`, otherCompanyId);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: foreignPrizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('P0002');
  });

  it('refuses a delegate who holds promotions.edit but not promotions.prizes', async () => {
    const label = `link-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Guarded ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    // The whole reason promotions.prizes is its own code: rewording a
    // promotion is not committing inventory to it.
    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.edit']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('42501');
  });
});

describe('unlinking', () => {
  it('returns the units and leaves no row behind once the link reaches zero', async () => {
    const label = `unlink-all-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Radio ${label}`);
    await stockAsOwner(customer, prizeId, 8);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    const undo = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(undo.error).toBeNull();

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 8, linked: 0 });

    // Soft-deleted, so the tab shows nothing rather than a row of zeros. The
    // policy in 0046 filters deleted_at, which is why this read comes back
    // empty rather than with a zeroed row.
    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(0);

    // And the same pair can be linked again afterwards — the partial unique
    // index is what makes that possible.
    const relink = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(relink.error).toBeNull();
  });

  it('refuses to go below what has been drawn, naming both figures', async () => {
    const label = `unlink-floor-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Console ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });
    const linkId = linked.data as string;

    // Nothing writes `drawn` until Block 6; see the helper's own comment for
    // why this is the only fixture available and why this test must not go on
    // to assert that reconciliation is clean.
    setPromotionPrizeDrawnDirectly(linkId, 2);

    // Three of the five may come back.
    const allowed = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(allowed.error).toBeNull();

    // The fourth may not, and the refusal names the two that are spoken for.
    const denied = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('23514');
    expect(denied.error?.message).toContain('2');
  });

  it('refuses a prize that is not linked to this promotion', async () => {
    const label = `unlink-none-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Unlinked ${label}`);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('P0002');
  });

  it('refuses an unlink by a delegate who holds promotions.edit but not promotions.prizes', async () => {
    const label = `unlink-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Watched ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    // Fixture, so that the refusal below is about the permission and nothing
    // else — the link has to be there for the delegate to fail to undo it.
    const owner = await clientFor(customer);
    const { error: linkError } = await owner.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    if (linkError) throw new Error(`link_prize_to_promotion failed: ${linkError.message}`);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.edit']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('42501');
  });

  it('reports no divergence after a link and unlink round trip', async () => {
    const label = `unlink-recon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Audited ${label}`);
    await stockAsOwner(customer, prizeId, 12);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 7,
    });
    expect(link.error).toBeNull();

    const undo = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    expect(undo.error).toBeNull();

    // Asserted BEFORE reconciling, and load-bearing rather than decorative:
    // reconcile_inventory over a Station that holds no link at all also returns
    // [], so an empty result on its own says "nothing to recompute" just as
    // readily as "recomputed and agreed". These two reads are what fix which of
    // the two it is — there is a live link, with two movements behind it, and
    // the stored figure the per-promotion half is about to recompute stands at
    // 5. Without them this case passed while neither RPC existed, which is how
    // the hole was found.
    const balance = await client
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', link.data as string)
      .single();
    expect(balance.data).toEqual({ linked: 5, drawn: 0 });

    const movements = await client
      .from('inventory_movements')
      .select('movement_type, quantity')
      .eq('promotion_prize_id', link.data as string)
      .order('movement_type');
    expect(movements.data).toEqual([
      { movement_type: 'PROMOTION_LINK', quantity: 7 },
      { movement_type: 'PROMOTION_UNLINK', quantity: 2 },
    ]);

    // The second projection recomputed from the ledger must equal what the RPCs
    // wrote. This is the assertion that goes red if the per-promotion write is
    // dropped from apply_inventory_movement — see the mutation log in Task 9.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
});
