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
    // Checked, because everything below compares against first.data: if the
    // first link failed, `toBe(first.data)` would be comparing a uuid against
    // null and the case would fail naming the wrong call.
    expect(first.error).toBeNull();

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
    // The message, not only the code, because two guards raise 22023 on this
    // path and the code alone cannot tell them apart: delete the check in
    // link_prize_to_promotion and control reaches apply_inventory_movement's
    // own ("quantity must be a positive whole number"), which raises 22023 too
    // and rolls the link row back with the transaction, leaving a
    // code-only assertion green over a guard that is no longer there. This
    // pins the RPC's own wording, which is the one that reaches the screen.
    expect(denied.error?.message).toBe('the number of units must be a positive whole number');
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

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(link.error).toBeNull();

    // The positive control for the assertion further down. PostgREST answers []
    // both for a row a policy filtered out and for a client that cannot read
    // the table at all, so "empty afterwards" on its own cannot tell
    // soft-deleted from never-visible. This read, through the same client and
    // the same policy, is what fixes which of the two the zero below means.
    const before = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(before.data).toEqual([{ id: link.data }]);

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

  it('reports a drawn figure the ledger cannot account for', async () => {
    const label = `recon-drawn-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeName = `Counted ${label}`;
    const prizeId = await createPrizeAs(customer, prizeName);
    await stockAsOwner(customer, prizeId, 6);
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
      p_quantity: 3,
    });
    expect(link.error).toBeNull();

    const promotion = await client
      .from('promotions')
      .select('name')
      .eq('id', promotionId)
      .single();

    // The case that dies if 0048's per-promotion half is deleted, which the
    // clean round trip below cannot be: [] is what an absent half returns too,
    // so a suite holding only that one asserts a reconciler's silence rather
    // than its work. This asserts the row it is supposed to produce.
    //
    // No conflict with setPromotionPrizeDrawnDirectly's own warning — that
    // forbids asserting reconciliation is CLEAN after using it, because the
    // helper leaves a real divergence. Asserting the divergence is the opposite,
    // and it is the only way to reach `drawn` at all: nothing writes it until
    // Block 6 brings the draw.
    setPromotionPrizeDrawnDirectly(link.data as string, 1);

    // Exactly one row, and every field of it. `linked` agrees (3 linked, 3 in
    // the ledger) and so does every inventory_balances bucket, so the drawn arm
    // is the only thing that can be speaking here: stored 1 against computed 0,
    // which is the truth — the ledger has no DRAW movement behind it, and
    // cannot until Block 6 widens inventory_movements_promotion_reference.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([
      {
        prize_id: prizeId,
        prize_name: prizeName,
        promotion_prize_id: link.data,
        promotion_name: promotion.data?.name,
        bucket: 'drawn',
        stored: 1,
        computed: 0,
      },
    ]);
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
    // wrote.
    //
    // What this assertion does NOT catch, stated because the obvious reading is
    // wrong and was written down as fact once already: it is not what goes red
    // if apply_inventory_movement's per-promotion write is dropped. Drop that
    // block and ensure_promotion_prize_balance_row still bootstraps the all-zero
    // row, `linked` stays 0, and the unlink of 2 hits this RPC's own floor and
    // raises 23514 — so the CASE goes red, thirty lines above, at
    // expect(undo.error).toBeNull(). Measured, not reasoned: that mutation was
    // run against this file.
    //
    // Its own job is the other failure: a stored figure that is WRONG rather
    // than missing. Set this link's `linked` to 9 by hand and reconciliation
    // returns one row, stored 9 against computed 5. The case above — `reports a
    // drawn figure the ledger cannot account for` — is the one that proves the
    // per-promotion half emits a row at all, which this one cannot, because []
    // is also what a half that had been deleted outright would return.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
});

describe('a promotion that ends its life hands its prizes back', () => {
  it('cancelling returns every undrawn unit and leaves the drawn ones alone', async () => {
    const label = `cancel-d1-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Watch ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 6,
    });
    // Checked, because everything below rests on this link: without it the next
    // line is what goes red, and setPromotionPrizeDrawnDirectly's UUID guard
    // would blame the fixture helper for a link that never happened.
    expect(linked.error).toBeNull();
    const linkId = linked.data as string;
    setPromotionPrizeDrawnDirectly(linkId, 2);

    const cancelled = await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'sponsor pulled out',
    });
    expect(cancelled.error).toBeNull();

    // Four of the six come back. The two that are drawn belong to a winner and
    // nothing here may take them — and they are still in the `linked` bucket,
    // which is what the figures below say: they will move to awaiting_pickup
    // only once Block 6 brings the draw that moves them. Nothing writes `drawn`
    // or touches awaiting_pickup before that block, which is exactly why this
    // fixture has to write the projection by hand.
    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 8, linked: 2 });

    // The link row survives, because it still has to show Sorteados 2.
    const balance = await client
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', linkId)
      .single();
    expect(balance.data).toEqual({ linked: 2, drawn: 2 });

    // The movement carries the cancellation, so the ledger explains itself
    // without anybody having to cross-reference the promotion.
    const movements = await client
      .from('inventory_movements')
      .select('movement_type, quantity, note')
      .eq('promotion_prize_id', linkId)
      .eq('movement_type', 'PROMOTION_UNLINK');
    expect(movements.data).toHaveLength(1);
    // `?.[0]?.` rather than `data![0].`: noUncheckedIndexedAccess is on, so the
    // element is possibly-undefined however certain the non-null assertion is
    // about the array. The same idiom inventory.test.ts already uses.
    expect(movements.data?.[0]?.quantity).toBe(4);
    expect(movements.data?.[0]?.note).toContain('sponsor pulled out');
  });

  it('cancelling closes a link that had nothing drawn', async () => {
    const label = `cancel-close-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Camera ${label}`);
    await stockAsOwner(customer, prizeId, 4);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 4,
    });
    expect(link.error).toBeNull();

    // The positive control for the assertion at the end, and the same one
    // `returns the units and leaves no row behind` needs for the same reason:
    // PostgREST answers [] for a row a policy filtered out, for a client that
    // cannot read the table at all, and for a link that was never created — so
    // "empty afterwards" cannot on its own tell a soft-delete from any of the
    // three. Asserted as the link's own id, so it also pins WHICH row was there.
    const before = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(before.data).toEqual([{ id: link.data }]);

    const cancelled = await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'no longer running',
    });
    expect(cancelled.error).toBeNull();

    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(0);
  });

  it('archiving an ended promotion returns its prizes rather than stranding them', async () => {
    const label = `archive-strand-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Tablet ${label}`);
    await stockAsOwner(customer, prizeId, 9);
    // Ended, never cancelled. cancel_promotion refuses this one outright, so
    // before this task its prizes had no way back at all.
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() - 2 * DAY).toISOString(),
      endsAt: new Date(Date.now() - HOUR).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.archive',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });
    expect(link.error).toBeNull();

    // Asserted BEFORE the archival, and load-bearing rather than decorative:
    // { available: 9, linked: 0 } at the end is also exactly what a Station
    // whose link never happened reads. Without this the case would go green
    // over a link_prize_to_promotion that had refused this ended promotion
    // outright — which is precisely the thing 0049 deliberately allows and
    // which this case's whole premise depends on.
    const committed = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(committed.data).toEqual({ available: 4, linked: 5 });

    const archived = await client.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 9, linked: 0 });
  });

  it('archiving after a cancellation finds nothing left to return', async () => {
    const label = `archive-after-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Voucher ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'promotions.archive',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(link.error).toBeNull();
    const cancelled = await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'called off',
    });
    expect(cancelled.error).toBeNull();

    // Read BETWEEN the two operations, because the end state alone cannot say
    // WHICH of them returned the units: with the cancellation returning nothing
    // the archival would return all three on its own and every assertion below
    // would read exactly the same. These two are what fix the cancellation as
    // the one that acted, which is the premise the name rests on.
    const afterCancel = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(afterCancel.data).toEqual({ available: 3, linked: 0 });

    const beforeArchive = await client
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId)
      .eq('movement_type', 'PROMOTION_UNLINK');
    expect(beforeArchive.data).toHaveLength(1);

    const archived = await client.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    // Three back, and still exactly one PROMOTION_UNLINK — not two. What this
    // count catches is a REPEATED return: a helper that walked links it had
    // already closed, or an archival that re-created the link and unwound it a
    // second time. The query is by prize rather than by link precisely so that
    // a movement written against a second, wrongly re-created link is still
    // counted here.
    //
    // What it does NOT catch, said plainly because the obvious reading is the
    // wrong one: a helper that did nothing at all during the ARCHIVAL also
    // leaves exactly one movement — the cancellation's — and this assertion
    // accepts that. It cannot attribute the return to either operation. The two
    // reads above, taken between the cancel and the archive, are what do that,
    // and they are load-bearing rather than redundant with this one.
    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 3, linked: 0 });

    const movements = await client
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId)
      .eq('movement_type', 'PROMOTION_UNLINK');
    expect(movements.data).toHaveLength(1);
  });

  it('reports no divergence after a cancellation returned the units', async () => {
    const label = `cancel-recon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Checked ${label}`);
    await stockAsOwner(customer, prizeId, 6);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 6,
    });
    expect(link.error).toBeNull();
    const cancelled = await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'weather',
    });
    expect(cancelled.error).toBeNull();

    // Asserted BEFORE reconciling, for the reason `reports no divergence after
    // a link and unlink round trip` sets out at length: reconcile_inventory
    // returns [] just as readily over a Station where the cancellation moved
    // nothing at all, so an empty result on its own says "nothing to recompute"
    // as easily as "recomputed and agreed". Measured, not reasoned — without
    // this read the case was the ONE green line in this describe's RED run,
    // passing over a cancel_promotion that returned nothing whatsoever.
    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 6, linked: 0 });

    // The link this reconciliation is about, named so the [] below cannot be
    // read as "there was nothing here". It is asserted through the ledger
    // rather than through promotion_prize_balances because the cancellation
    // soft-deleted the link, and 0046's policy on the projection is carried by
    // the one on promotion_prizes, which filters deleted_at — the row is real
    // and reconciled, and deliberately out of the ordinary read path.
    const movements = await client
      .from('inventory_movements')
      .select('movement_type, quantity')
      .eq('promotion_prize_id', link.data as string)
      .order('movement_type');
    expect(movements.data).toEqual([
      { movement_type: 'PROMOTION_LINK', quantity: 6 },
      { movement_type: 'PROMOTION_UNLINK', quantity: 6 },
    ]);

    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
});

describe('reading the Prizes tab', () => {
  it('names the prize for a delegate who holds no inventory permission at all', async () => {
    const label = `read-names-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Turntable ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    const linker = await grantRoleWith(customer, `${label}-w`, [
      'promotions.view',
      'promotions.prizes',
    ]);
    const linkerClient = await clientFor(linker);
    const link = await linkerClient.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    // Checked, because every assertion below rests on this link: without it the
    // tab is legitimately empty and the case would fail naming
    // list_promotion_prizes for a link that never happened.
    expect(link.error).toBeNull();

    // promotions.view alone. This delegate cannot read public.prizes at all —
    // which is exactly why the tab goes through a SECURITY DEFINER read.
    const reader = await grantRoleWith(customer, `${label}-r`, ['promotions.view']);
    const client = await clientFor(reader);

    const direct = await client.from('prizes').select('name').eq('id', prizeId);
    expect(direct.data).toEqual([]);

    const tab = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(tab.error).toBeNull();
    expect(tab.data).toEqual([
      {
        // The link's own id rather than any string: the tab's row has to be the
        // row link_prize_to_promotion created, and a screen that opens a link by
        // this id would be broken by an id that merely has the right shape.
        promotion_prize_id: link.data,
        prize_id: prizeId,
        prize_name: `Turntable ${label}`,
        linked: 3,
        drawn: 0,
      },
    ]);
  });

  it('refuses a delegate holding nothing in this Station', async () => {
    const label = `read-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    const stranger = await grantRoleWith(customer, label, ['members.view']);
    const client = await clientFor(stranger);

    const denied = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(denied.error?.code).toBe('42501');
  });

  it('reads an id that is not there as empty rather than raising not-found', async () => {
    const label = `read-oracle-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const client = await clientFor(await grantRoleWith(customer, label, ['promotions.view']));

    // An id that matches no row at all reads exactly like a live promotion with
    // nothing linked and like an archived one seen by a delegate: empty. An
    // empty tab is therefore never by itself evidence about an id.
    //
    // What this deliberately does NOT claim, because the case above makes it
    // false: a promotion that DOES exist, in a Station where the caller holds
    // nothing, is refused with 42501 — which does tell that caller the id is
    // real. Folding that refusal into an empty list was the alternative and was
    // rejected: the screen could then not tell "you may not see this" from "this
    // promotion has no prizes", and 0049's write RPCs already give the same
    // signal for the same ids to whoever already holds one.
    const missing = await client.rpc('list_promotion_prizes', {
      p_promotion_id: '00000000-0000-0000-0000-0000000000ff',
    });
    expect(missing.error).toBeNull();
    expect(missing.data).toEqual([]);
  });

  it('hides an archived promotion’s prizes from a delegate and shows them to the owner', async () => {
    const label = `read-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Filed ${label}`);
    await stockAsOwner(customer, prizeId, 4);
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() + DAY).toISOString(),
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.archive',
    ]);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 4,
    });
    expect(link.error).toBeNull();

    // Archiving now returns every undrawn unit and closes every link that has
    // nothing drawn (0050), so a link survives an archival only if something has
    // been drawn on it. Without this the archived promotion would have no live
    // link at all and BOTH halves below would read [] — the delegate's for the
    // rule this case exists to prove, and the owner's vacuously. Linking twice
    // instead does not help: 0049 adds to the live row rather than creating a
    // second one, which the second case of the first describe already pins.
    setPromotionPrizeDrawnDirectly(link.data as string, 2);

    // The positive control for the [] the delegate gets after the archival.
    // Through the same client and the same function, so that empty list means
    // "hidden" rather than "there was never a row here" — and it also fixes that
    // the fixture above landed on the row this case is about.
    const before = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(before.data).toHaveLength(1);
    expect(before.data?.[0]).toMatchObject({ linked: 4, drawn: 2 });

    const archived = await client.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    // 0044 admits an archived promotion to the owner and the platform admin
    // only. A DEFINER body never consults that policy, so the rule has to be
    // restated inside the function — and this is the case that proves it was.
    const hidden = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(hidden.error).toBeNull();
    expect(hidden.data).toEqual([]);

    const ownerClient = await clientFor(customer);
    const visible = await ownerClient.rpc('list_promotion_prizes', {
      p_promotion_id: promotionId,
    });
    expect(visible.data).toHaveLength(1);
    // Two of the four went back to available as the promotion was archived; the
    // two that are drawn belong to a winner and stay on the tab.
    expect(visible.data?.[0]).toMatchObject({ linked: 2, drawn: 2 });
  });

  it('leaves a link that was unwound to nothing off the tab', async () => {
    const label = `read-unwound-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Returned ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const link = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(link.error).toBeNull();

    // The positive control: the row is on the tab before the unlink, so the []
    // below is a row being filtered rather than a link that never happened.
    const before = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(before.data).toHaveLength(1);

    const undo = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(undo.error).toBeNull();

    // 0046's policy bakes `deleted_at is null` in and a DEFINER body never
    // consults it, so the filter is restated in the query: a link unwound to
    // nothing leaves the tab rather than sitting there as a row of zeros, and
    // its history is in the ledger. The neighbouring case in the unlinking
    // describe proves the POLICY does this; nothing proved the restatement did,
    // and an untested restatement is one edit away from being gone.
    const after = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(after.error).toBeNull();
    expect(after.data).toEqual([]);
  });

  it('offers linkable prizes with their available stock', async () => {
    const label = `read-picker-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Zither ${label}`);
    await stockAsOwner(customer, prizeId, 7);
    // A second prize, so the search below has something to leave out. With one
    // prize in the Station a search that was ignored outright would return that
    // same single row and `toHaveLength(1)` would pass over it.
    const otherId = await createPrizeAs(customer, `Kalimba ${label}`);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    // The premise the picker's DEFINER status rests on: this delegate holds
    // nothing from the inventory module, so neither the name nor the available
    // figure below can have come from a read it could have made itself.
    const direct = await client
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId);
    expect(direct.data).toEqual([]);

    const all = await client.rpc('list_linkable_prizes', { p_company_id: customer.companyId });
    expect(all.error).toBeNull();
    expect(all.data).toHaveLength(2);
    expect(all.data).toContainEqual({
      prize_id: prizeId,
      name: `Zither ${label}`,
      available: 7,
    });
    // A prize with nothing in stock is offered too, at zero — hiding it would
    // leave an operator hunting for a prize the inventory screen shows them, and
    // link_prize_to_promotion refuses the quantity anyway, naming the figure.
    expect(all.data).toContainEqual({
      prize_id: otherId,
      name: `Kalimba ${label}`,
      available: 0,
    });

    // The search is a plain substring, not a LIKE pattern: a term with a % in
    // it is a term, not a wildcard.
    const found = await client.rpc('list_linkable_prizes', {
      p_company_id: customer.companyId,
      p_search: 'zither',
    });
    expect(found.data).toEqual([{ prize_id: prizeId, name: `Zither ${label}`, available: 7 }]);

    const none = await client.rpc('list_linkable_prizes', {
      p_company_id: customer.companyId,
      p_search: '%',
    });
    expect(none.data).toEqual([]);
  });

  it('caps the picker at fifty, and the search is how you reach the fifty-first', async () => {
    const label = `read-cap-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    // Fifty-one prizes, so the cap has something to cut. Registered through the
    // real RPC on one owner client rather than through createPrizeAs, which
    // signs in again on every call.
    const bulk = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        owner.rpc('create_prize', {
          p_company_id: customer.companyId,
          p_name: `Capped ${label} ${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    for (const one of bulk) {
      if (one.error) throw new Error(`create_prize failed: ${one.error.message}`);
    }
    // Named so it sorts last, which is what puts it outside the fifty.
    const beyond = await owner.rpc('create_prize', {
      p_company_id: customer.companyId,
      p_name: `Zzz beyond ${label}`,
    });
    expect(beyond.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const capped = await client.rpc('list_linkable_prizes', { p_company_id: customer.companyId });
    expect(capped.error).toBeNull();
    expect(capped.data).toHaveLength(50);
    // Which fifty, not merely how many: the list is ordered by name and cut at
    // the end of that order, so the fifty-first is the one missing.
    expect(capped.data?.map((row) => row.prize_id)).not.toContain(beyond.data);

    // And the search is how somebody reaches it — the whole of what the cap
    // costs, and why the screen has to say the list is capped rather than
    // present it as the Station's whole catalogue.
    const searched = await client.rpc('list_linkable_prizes', {
      p_company_id: customer.companyId,
      p_search: 'zzz beyond',
    });
    expect(searched.data).toHaveLength(1);
    expect(searched.data?.[0]?.prize_id).toBe(beyond.data);
  });

  it('refuses the picker to a delegate who may see promotions but not commit stock to them', async () => {
    const label = `read-picker-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const client = await clientFor(await grantRoleWith(customer, label, ['promotions.view']));

    const denied = await client.rpc('list_linkable_prizes', { p_company_id: customer.companyId });
    expect(denied.error?.code).toBe('42501');
  });

  it('keeps promotion_prize_balances itself from a delegate who cannot see the promotion', async () => {
    const label = `read-balance-rls-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Ledgered ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    const linker = await grantRoleWith(customer, `${label}-w`, [
      'promotions.view',
      'promotions.prizes',
    ]);
    const linkerClient = await clientFor(linker);
    const link = await linkerClient.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    expect(link.error).toBeNull();

    // 0046's read policy on the projection had never been exercised under a role
    // holding nothing: the pgTAP suite checks only that the select grant exists
    // and that there is exactly one policy on the table, both of which a policy
    // written `using (true)` would satisfy. This is that case, and it belongs
    // here because these are the only tests with a real Station, a real delegate
    // and a real balance row to withhold.
    //
    // The read through the linker comes first because [] is also what PostgREST
    // answers for a table with nothing in it: this is what fixes the [] below as
    // a row that exists being withheld rather than a row never written.
    const readable = await linkerClient
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', link.data as string);
    expect(readable.data).toEqual([{ linked: 2, drawn: 0 }]);

    // A member of this same Station, so the Station is not what excludes them:
    // the only thing this delegate is missing is promotions.view.
    const stranger = await grantRoleWith(customer, `${label}-s`, ['members.view']);
    const strangerClient = await clientFor(stranger);

    const refused = await strangerClient
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', link.data as string);
    // Filtered by the policy rather than refused by a grant — the select grant
    // is there for every authenticated role, so an error here would mean the
    // grant had been taken away rather than the policy having done its work.
    expect(refused.error).toBeNull();
    expect(refused.data).toEqual([]);
  });
});
