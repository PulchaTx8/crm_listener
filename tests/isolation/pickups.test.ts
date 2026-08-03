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
