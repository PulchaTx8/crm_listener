import { afterAll, describe, expect, it } from 'vitest';
import { admin, cleanupUsers, createPrizeAs, grantRoleWith, provisionCustomer, signInAs } from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A SECURITY DEFINER function that replaces a query under RLS inherits
 * NOTHING. Block 6c learned it the expensive way: list_participations became a
 * function and lost the rule hiding participations of archived promotions, for
 * five commits, seen by neither pgTAP nor tsc nor ESLint nor Playwright. Only
 * this suite found it. So these four cases are written in the same task as the
 * function, not after the block.
 */
describe('list_pickups', () => {
  /**
   * Real fixture rather than an in-line inline sequence of RPCs, because three
   * of the four cases below need exactly this shape and only the window
   * differs. Everything runs as the owner: the owner bypasses every
   * has_permission check for their own Organization (0024), which is the same
   * bypass every fixture helper elsewhere in this suite already leans on
   * (createPrizeAs's own comment, and draw.test.ts's seedAndDraw calling
   * record_participation directly as owner).
   *
   * Ends in the future by default, so run_draw needs no further contortion;
   * case 2 passes a window that has ALREADY ended, because archive_promotion
   * (0042) refuses a promotion still inside its window.
   */
  async function seedPickupWinner(
    customer: ProvisionedCustomer,
    label: string,
    window: { starts: Date; ends: Date } = {
      starts: new Date(Date.now() - 2 * DAY),
      ends: new Date(Date.now() + 20 * DAY),
    },
  ): Promise<{ promotionId: string; winnerId: string; memberId: string }> {
    const owner = await signInAs(customer.email, customer.password);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);

    const stock = await owner.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 1,
    });
    if (stock.error) throw new Error(`record_stock_entry failed: ${stock.error.message}`);

    const promotion = await owner.rpc('create_promotion', {
      p_company_id: customer.companyId,
      p_name: `Promo ${label}`,
      p_starts_at: window.starts.toISOString(),
      p_ends_at: window.ends.toISOString(),
    });
    if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
    const promotionId = promotion.data as string;

    const link = await owner.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    if (link.error) throw new Error(`link_prize_to_promotion failed: ${link.error.message}`);

    const member = await owner.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Listener ${label}`,
    });
    if (member.error) throw new Error(`create_member failed: ${member.error.message}`);
    const memberId = member.data as string;

    // Inside the window regardless of where "now" sits relative to it — the
    // same trick participations.test.ts's own archived-promotion case relies
    // on (apply_participation checks p_participated_at against the window,
    // not the clock).
    const participated = await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date(window.starts.getTime() + HOUR).toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    if (participated.error) {
      throw new Error(`record_participation failed: ${participated.error.message}`);
    }
    if ((participated.data as { status: string } | null)?.status !== 'VALID') {
      throw new Error(`fixture participation was not VALID: ${JSON.stringify(participated.data)}`);
    }

    const drawn = await owner.rpc('run_draw', { p_promotion_id: promotionId, p_units: null });
    if (drawn.error) throw new Error(`run_draw failed: ${drawn.error.message}`);

    const winner = await admin
      .from('winners')
      .select('id')
      .eq('draw_id', drawn.data as string)
      .single();
    if (winner.error || !winner.data) {
      throw new Error(`fixture winner missing: ${winner.error?.message}`);
    }

    return { promotionId, winnerId: winner.data.id as string, memberId };
  }

  it('refuses a Station the caller holds no role in, with 42501 and not an empty page', async () => {
    const labelA = `pickups-strangerA-${Date.now()}`;
    const labelB = `pickups-strangerB-${Date.now()}`;
    const customerA = await provisionCustomer(labelA);
    const customerB = await provisionCustomer(labelB);

    // A REAL winner at B. If a future change turned the refusal into an empty
    // array, that array would be wrong rather than merely unconvincing — there
    // genuinely is something to hide here.
    await seedPickupWinner(customerB, labelB);

    // customerA is the owner of a completely different Organization: no
    // membership, no ownership, nothing at Company B.
    const clientA = await signInAs(customerA.email, customerA.password);
    const denied = await clientA.rpc('list_pickups', { p_company_id: customerB.companyId });

    expect(denied.error?.code).toBe('42501');
    // Not merely an error CODE: the response carries no rows at all, which is
    // the other half of "refused, not shown an empty page".
    expect(denied.data).toBeNull();
  });

  it('hides the winners of an archived promotion from a delegate', async () => {
    const label = `pickups-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);

    // A window that has ALREADY ended, so archive_promotion's own guard
    // ("still accepting entries; cancel it before archiving", 0042) never
    // fires and no separate promotions.cancel grant is needed.
    const { promotionId, winnerId } = await seedPickupWinner(customer, label, {
      starts: new Date(Date.now() - 10 * DAY),
      ends: new Date(Date.now() - 1 * DAY),
    });

    const owner = await signInAs(customer.email, customer.password);
    const archived = await owner.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, ['promotions.view']);
    const delegateClient = await signInAs(delegate.email, delegate.password);

    // Not merely un-navigable through the promotion filter: absent from the
    // Station's list as a whole too, the same pair 11_filtered_hat.test.sql
    // pins for list_participations.
    const scoped = await delegateClient.rpc('list_pickups', {
      p_company_id: customer.companyId,
      p_promotion_id: promotionId,
    });
    expect(scoped.error).toBeNull();
    expect(scoped.data ?? []).toHaveLength(0);

    const whole = await delegateClient.rpc('list_pickups', { p_company_id: customer.companyId });
    expect(whole.error).toBeNull();
    expect((whole.data ?? []).some((row) => row.winner_id === winnerId)).toBe(false);

    // And the Organization's owner still reads it — 0044's rule, restated for
    // this function rather than inherited from it, keeps the owner able to
    // resolve a discrepancy without going in blind.
    const asOwner = await owner.rpc('list_pickups', {
      p_company_id: customer.companyId,
      p_promotion_id: promotionId,
    });
    expect(asOwner.error).toBeNull();
    expect((asOwner.data ?? []).some((row) => row.winner_id === winnerId)).toBe(true);
  });

  it('returns rows but null names to a caller without members.view', async () => {
    const label = `pickups-noNames-${Date.now()}`;
    const customer = await provisionCustomer(label);
    await seedPickupWinner(customer, label);

    // promotions.view only — no members.view at all.
    const delegate = await grantRoleWith(customer, label, ['promotions.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const result = await client.rpc('list_pickups', { p_company_id: customer.companyId });
    expect(result.error).toBeNull();
    expect((result.data ?? []).length).toBeGreaterThan(0);
    expect((result.data ?? []).every((row) => row.member_name === null)).toBe(true);
    expect((result.data ?? []).every((row) => row.member_phone === null)).toBe(true);
  });

  it('returns nothing at all when a caller without members.view searches', async () => {
    const label = `pickups-oracle-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const { memberId } = await seedPickupWinner(customer, label);

    const delegate = await grantRoleWith(customer, label, ['promotions.view']);
    const client = await signInAs(delegate.email, delegate.password);

    // The listener's OWN real name — not a term picked to miss. A version of
    // the guard that merely narrowed the net (rather than shutting it) would
    // still find them, since this is exactly who is there to be found.
    const listener = await admin.from('members').select('full_name').eq('id', memberId).single();
    expect(listener.error).toBeNull();

    const result = await client.rpc('list_pickups', {
      p_company_id: customer.companyId,
      p_search: listener.data?.full_name ?? 'Listener',
    });
    expect(result.error).toBeNull();
    expect(result.data ?? []).toHaveLength(0);
  });
});

/**
 * Block 6d, Task 6: list_movements, the Station's whole stock ledger as one
 * list. It exists as a function for a DIFFERENT reason than list_pickups:
 * inventory_movements already has a working RLS select policy gated on
 * inventory.view alone (0029), so the ROW needs no function. The promotion
 * NAME does -- inventory_movements.promotion_prize_id is nullable WITH
 * MEANING (null is a purchase entry or a stock adjustment, belonging to no
 * promotion at all), and a plain embed of promotion_prizes -> promotions
 * would additionally require promotions.view through promotions' own RLS
 * (0044), making a name withheld for lack of that permission indistinguishable
 * from the genuine "no promotion" null. So the function returns the name to
 * anyone holding inventory.view, and the case below is the whole reason it
 * exists rather than a plain query.
 *
 * The archived-promotion rule is not list_pickups' RULE 4 restated: that
 * function hides the WHOLE winner row; this one hides only the NAME, because
 * a movement is the Station's own stock history and hiding the row would
 * delete it from an inventory screen. promotion_archived says which of the
 * two possible nulls the missing name is, and the case below proves both the
 * delegate's null and the owner's name against the SAME row.
 */
describe('list_movements', () => {
  /**
   * Minimal fixture for this function: a prize, given stock through the real
   * record_stock_entry RPC. Unlike seedPickupWinner above, list_movements
   * needs no participation, no draw and no winner -- it reads the ledger
   * itself, and a stock entry is the ledger's simplest possible row.
   */
  async function seedEntryMovement(
    customer: ProvisionedCustomer,
    label: string,
  ): Promise<{ movementId: string; prizeId: string }> {
    const owner = await signInAs(customer.email, customer.password);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);

    const entry = await owner.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 3,
    });
    if (entry.error) throw new Error(`record_stock_entry failed: ${entry.error.message}`);

    return { movementId: entry.data as string, prizeId };
  }

  it('refuses a Station the caller holds no role in, with 42501 and not an empty page', async () => {
    const labelA = `movements-strangerA-${Date.now()}`;
    const labelB = `movements-strangerB-${Date.now()}`;
    const customerA = await provisionCustomer(labelA);
    const customerB = await provisionCustomer(labelB);

    // A REAL movement at B. If a future change turned the refusal into an
    // empty array, that array would be wrong rather than merely unconvincing —
    // there genuinely is something to hide here.
    await seedEntryMovement(customerB, labelB);

    // customerA is the owner of a completely different Organization: no
    // membership, no ownership, nothing at Company B.
    const clientA = await signInAs(customerA.email, customerA.password);
    const denied = await clientA.rpc('list_movements', { p_company_id: customerB.companyId });

    expect(denied.error?.code).toBe('42501');
    // Not merely an error CODE: the response carries no rows at all, which is
    // the other half of "refused, not shown an empty page".
    expect(denied.data).toBeNull();
  });

  it('returns the promotion name to an inventory-only caller, because null already means something', async () => {
    // inventory_movements.promotion_prize_id is nullable WITH MEANING: null is a
    // purchase entry or an adjustment, which belongs to no promotion. A name
    // withheld for lack of promotions.view would be indistinguishable from that.
    const label = `movements-nameVisible-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);

    const { prizeId } = await seedEntryMovement(customer, label);

    const promotion = await owner.rpc('create_promotion', {
      p_company_id: customer.companyId,
      p_name: `Promo ${label}`,
      p_starts_at: new Date(Date.now() - DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
    });
    if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
    const promotionId = promotion.data as string;

    const link = await owner.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    if (link.error) throw new Error(`link_prize_to_promotion failed: ${link.error.message}`);

    const linkMovement = await admin
      .from('inventory_movements')
      .select('id')
      .eq('promotion_prize_id', link.data as string)
      .eq('movement_type', 'PROMOTION_LINK')
      .single();
    if (linkMovement.error || !linkMovement.data) {
      throw new Error(`fixture link movement missing: ${linkMovement.error?.message}`);
    }

    // inventory.view only — no promotions.view at all. If this function
    // required promotions.view for the name the way a plain embed would,
    // this caller would see the promotion side as null, indistinguishable
    // from a movement that belongs to no promotion.
    const delegate = await grantRoleWith(customer, label, ['inventory.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const result = await client.rpc('list_movements', { p_company_id: customer.companyId });
    expect(result.error).toBeNull();

    const row = (result.data ?? []).find((r) => r.movement_id === linkMovement.data!.id);
    expect(row).toBeTruthy();
    expect(row?.promotion_id).toBe(promotionId);
    expect(row?.promotion_name).toBe(`Promo ${label}`);
    expect(row?.promotion_archived).toBe(false);
  });

  it('shows a delegate that a movement belongs to an archived promotion, without naming it', async () => {
    // 0044 archives promotions away from delegates. The movement is still the
    // Station's stock history and still lists; the name does not, and
    // promotion_archived says which null this is.
    const label = `movements-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);

    const { prizeId } = await seedEntryMovement(customer, label);

    // A window that has ALREADY ended, so archive_promotion's own guard
    // ("still accepting entries; cancel it before archiving", 0042) never
    // fires and no separate promotions.cancel grant is needed.
    const promotion = await owner.rpc('create_promotion', {
      p_company_id: customer.companyId,
      p_name: `Promo ${label}`,
      p_starts_at: new Date(Date.now() - 10 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
    const promotionId = promotion.data as string;

    const link = await owner.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    if (link.error) throw new Error(`link_prize_to_promotion failed: ${link.error.message}`);

    const linkMovement = await admin
      .from('inventory_movements')
      .select('id')
      .eq('promotion_prize_id', link.data as string)
      .eq('movement_type', 'PROMOTION_LINK')
      .single();
    if (linkMovement.error || !linkMovement.data) {
      throw new Error(`fixture link movement missing: ${linkMovement.error?.message}`);
    }
    const movementId = linkMovement.data.id as string;

    const archived = await owner.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, ['inventory.view']);
    const delegateClient = await signInAs(delegate.email, delegate.password);

    // Not merely un-navigable through the promotion filter: the row itself is
    // still present in the whole-station list, its id intact — only the name
    // is withheld.
    const asDelegate = await delegateClient.rpc('list_movements', { p_company_id: customer.companyId });
    expect(asDelegate.error).toBeNull();
    const delegateRow = (asDelegate.data ?? []).find((r) => r.movement_id === movementId);
    expect(delegateRow).toBeTruthy();
    expect(delegateRow?.promotion_id).toBe(promotionId);
    expect(delegateRow?.promotion_name).toBeNull();
    expect(delegateRow?.promotion_archived).toBe(true);

    // And the Organization's owner still reads the name — 0044's rule,
    // restated for this function rather than inherited from it, keeps the
    // owner able to resolve a discrepancy without going in blind.
    const asOwner = await owner.rpc('list_movements', { p_company_id: customer.companyId });
    expect(asOwner.error).toBeNull();
    const ownerRow = (asOwner.data ?? []).find((r) => r.movement_id === movementId);
    expect(ownerRow).toBeTruthy();
    expect(ownerRow?.promotion_name).toBe(`Promo ${label}`);
    expect(ownerRow?.promotion_archived).toBe(true);
  });
});
