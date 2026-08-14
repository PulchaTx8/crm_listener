import { afterAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import {
  addCompany,
  addMemberByInvitation,
  admin,
  cleanupUsers,
  createPrizeAs,
  createRoleAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

/**
 * `reverse_movement` (0195) is not in `database.types.ts` yet, and this file
 * deliberately does not put it there. Regenerating that file also pulls in
 * Block 23's two new `inventory_movement_type` values, which
 * `src/app/(app)/inventory/format.ts` maps to translation keys through an
 * exhaustive `Record<InventoryMovementType, string>` — so a regeneration turns
 * `npm run typecheck` red until those two labels and their copy exist in three
 * languages, which is a later task's work. That file's own comment records the
 * identical episode for `RETURN_PENDING_CANCEL`.
 *
 * So the call is typed here instead. Narrowly: the argument shape and the
 * result shape are both spelled out, so a wrong parameter name is still a
 * compile error — this is a bridge over one stale generated file, not an
 * escape from type checking.
 */
type ReverseResult = {
  data: string | null;
  error: { message: string; code: string } | null;
};

function reverseMovement(
  client: SupabaseClient<Database>,
  // p_note is REQUIRED, not optional: 0195 gives it no default, the same shape
  // record_stock_exit, reserve_stock and release_reservation all have, and the
  // body refuses a blank one with 22023. Typed required here so a call that
  // omits it is a compile error rather than a 42883 at run time.
  args: { p_movement_id: string; p_note: string },
): Promise<ReverseResult> {
  // `.bind(client)` is load-bearing, not tidiness: supabase-js's `rpc` reads
  // `this.rest` off the client, so a bare `client.rpc` lifted out of the object
  // throws "Cannot read properties of undefined (reading 'rest')" before it
  // ever reaches the database — measured, on the first run of this file.
  const call = client.rpc.bind(client) as unknown as (
    fn: 'reverse_movement',
    args: { p_movement_id: string; p_note: string },
  ) => Promise<ReverseResult>;
  return call('reverse_movement', args);
}

/**
 * The same stale-types bridge on the read side: `reverses_movement_id` is one
 * of the five columns 0193 added, so the generated Row type does not know it
 * either. `select('*')` is legal against the stale type and returns every
 * column the database actually has; only the shape assigned to it is restated
 * here.
 */
type MovementRow = {
  id: string;
  movement_type: string;
  quantity: number;
  from_bucket: string | null;
  to_bucket: string | null;
  reverses_movement_id: string | null;
  actor_id: string | null;
};

async function movementsForPrize(prizeId: string): Promise<MovementRow[]> {
  const { data, error } = await admin.from('inventory_movements').select('*').eq('prize_id', prizeId);
  expect(error).toBeNull();
  return (data ?? []) as unknown as MovementRow[];
}

async function movementById(id: string): Promise<MovementRow> {
  const { data, error } = await admin
    .from('inventory_movements')
    .select('*')
    .eq('id', id)
    .single();
  expect(error).toBeNull();
  return data as unknown as MovementRow;
}

/**
 * `reverse_movement` takes a movement id and NO Station, so unlike every other
 * door in 0027/0194 there is no `p_company_id` for a caller to be scoped
 * against — its entire tenant boundary is the `has_permission` call inside its
 * own body, resolved from the movement's own `company_id`. pgTAP cannot see any
 * of that: `supabase test db` runs as superuser with a null `auth.uid()`, where
 * `has_permission` answers true unconditionally and RLS never applies. Every
 * assertion here is driven by a real second identity holding a real, narrow
 * grant, through a real JWT.
 *
 * Per this repository's standing rule (Block 1c shipped two defects that
 * thirteen reviews missed because every scenario had the Organization owner
 * driving): the actor is a non-owner delegate in every case, and the owner
 * appears only as fixture seeding.
 */
describe('inventory reversal', () => {
  it('an operator holding inventory.entry reverses an entry in their own Station', async () => {
    const label = `rev-ok-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    // inventory.entry ALONE — no inventory.view. The door's gated read picks
    // the permission the original movement's kind required, so undoing an
    // entry must need exactly what recording one needed and nothing more. A
    // door that gated the read on inventory.view instead would refuse this.
    const delegate = await grantRoleWith(customer, label, ['inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 10,
    });
    expect(entry.error).toBeNull();
    const entryId = entry.data as string;

    const reversal = await reverseMovement(client, {
      p_movement_id: entryId,
      p_note: 'archived by the operator',
    });
    expect(reversal.error).toBeNull();
    expect(reversal.data).toBeTruthy();

    // The balance corrects itself by arithmetic (design D1) — the entry of ten
    // and its mirror sum to nothing, with no filter and no flag anywhere.
    const { data: balance, error: balanceError } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId)
      .single();
    expect(balanceError).toBeNull();
    expect(balance?.available).toBe(0);

    const mirror = await movementById(reversal.data as string);
    expect(mirror).toMatchObject({
      movement_type: 'MANUAL_EXIT',
      quantity: 10,
      from_bucket: 'available',
      to_bucket: null,
      reverses_movement_id: entryId,
      // The reversal names who made it (spec D1), and that is the DELEGATE —
      // not the owner who seeded the Station, and not a null a SECURITY
      // DEFINER body running as the table owner could easily have written.
      actor_id: delegate.userId,
    });
  });

  it('the same operator, handed a movement id from another Station, is refused — and can still read it', async () => {
    const label = `rev-scope-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const stationB = await addCompany(customer, 'Station Two');

    const entryRole = await createRoleAs(customer, `Entry-${label}`, ['inventory.entry']);
    // A LIVE membership in Station B, under a role granting inventory.view and
    // nothing else. Two things ride on that choice. Without ANY membership,
    // has_company_access would already be false and has_permission would
    // short-circuit before the role branch ran, leaving this test passing at
    // the access gate rather than at the layer it names — the correction Block
    // 1c's headline test needed, and the same shape inventory.test.ts uses.
    // And with inventory.view specifically, the delegate can genuinely SEE the
    // Station B movement through 0029's read policy, so the refusal below can
    // only be the door's own permission check: a door that gated reversing on
    // "can you read this row" would let this through.
    const viewerRole = await createRoleAs(customer, `Viewer-${label}`, ['inventory.view']);
    const delegate = await addMemberByInvitation(customer, label, entryRole, [customer.companyId]);

    const owner = await signInAs(customer.email, customer.password);
    const { error: assignError } = await owner.rpc('assign_company_role', {
      p_company_id: stationB,
      p_user_id: delegate.userId,
      p_role_id: viewerRole,
    });
    expect(assignError).toBeNull();

    const prizeInB = await createPrizeAs(customer, `Prize B ${label}`, stationB);
    const seededInB = await owner.rpc('record_stock_entry', {
      p_company_id: stationB,
      p_prize_id: prizeInB,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 8,
    });
    expect(seededInB.error).toBeNull();
    const movementInB = seededInB.data as string;

    const client = await signInAs(delegate.email, delegate.password);

    const { data: reachesB } = await client.rpc('has_company_access', { p_company_id: stationB });
    expect(reachesB).toBe(true);

    // The delegate really can read the row they are about to be refused.
    const visible = await client
      .from('inventory_movements')
      .select('id')
      .eq('id', movementInB)
      .single();
    expect(visible.error).toBeNull();
    expect(visible.data?.id).toBe(movementInB);

    const denied = await reverseMovement(client, {
      p_movement_id: movementInB,
      p_note: 'reaching across the boundary',
    });
    expect(denied.error).not.toBeNull();
    expect(denied.error!.code).toBe('42501');
    expect(denied.error!.message).toContain('permission denied');

    // Nothing was written: the Station B prize still has exactly the one
    // movement the owner seeded — no mirror, and nothing pointing at it — and
    // its balance is untouched. A door that raised only AFTER reaching
    // apply_inventory_movement would still leave this red.
    const movementsInB = await movementsForPrize(prizeInB);
    expect(movementsInB).toHaveLength(1);
    expect(movementsInB[0]?.id).toBe(movementInB);
    expect(movementsInB.some((row) => row.reverses_movement_id !== null)).toBe(false);

    const { data: balanceB } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeInB)
      .single();
    expect(balanceB?.available).toBe(8);

    // The positive control, and the reason the refusal above is scope rather
    // than a broken grant: the very same client still reverses an entry back
    // in Station A, where it does hold inventory.entry.
    const prizeInA = await createPrizeAs(customer, `Prize A ${label}`, customer.companyId);
    const entryInA = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeInA,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 3,
    });
    expect(entryInA.error).toBeNull();

    const allowed = await reverseMovement(client, {
      p_movement_id: entryInA.data as string,
      p_note: 'archived at home',
    });
    expect(allowed.error).toBeNull();
    expect(allowed.data).toBeTruthy();
  });

  it('inventory.exit does not confer inventory.entry: the permission follows the original movement kind', async () => {
    const label = `rev-kind-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);

    // Seeded by the owner, because this case is about which permission
    // REVERSING takes, not about recording — the delegate below deliberately
    // cannot record an entry at all.
    const owner = await signInAs(customer.email, customer.password);
    const seededEntry = await owner.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 10,
    });
    expect(seededEntry.error).toBeNull();
    const entryId = seededEntry.data as string;

    const seededExit = await owner.rpc('record_stock_exit', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 4,
      p_note: 'damaged',
    });
    expect(seededExit.error).toBeNull();
    const exitId = seededExit.data as string;

    const delegate = await grantRoleWith(customer, label, ['inventory.view', 'inventory.exit']);
    const client = await signInAs(delegate.email, delegate.password);

    const deniedEntry = await reverseMovement(client, {
      p_movement_id: entryId,
      p_note: 'not mine to undo',
    });
    expect(deniedEntry.error).not.toBeNull();
    expect(deniedEntry.error!.code).toBe('42501');

    // The control that makes the refusal mean something: the SAME client, the
    // SAME prize, undoing the EXIT instead — allowed, because it holds
    // inventory.exit. Without this half, a door that refused everybody would
    // score identically on the assertion above.
    const allowedExit = await reverseMovement(client, {
      p_movement_id: exitId,
      p_note: 'the write-off was a mistake',
    });
    expect(allowedExit.error).toBeNull();
    expect(allowedExit.data).toBeTruthy();

    // 10 in, 4 out, the 4 put back: six plus four. The entry's reversal never
    // happened, so this is 10 rather than 0.
    const { data: balance, error: balanceError } = await admin
      .from('inventory_balances')
      .select('available')
      .eq('prize_id', prizeId)
      .single();
    expect(balanceError).toBeNull();
    expect(balance?.available).toBe(10);

    const mirror = await movementById(allowedExit.data as string);
    expect(mirror).toMatchObject({
      movement_type: 'MANUAL_ENTRY',
      quantity: 4,
      from_bucket: null,
      to_bucket: 'available',
      reverses_movement_id: exitId,
    });
  });
});
