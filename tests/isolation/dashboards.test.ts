import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  createPrizeAs,
  createRoleAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 8a, Task 6. supabase/tests/20_dashboards.test.sql proves the
 * arithmetic of the three aggregates with 66 pgTAP assertions -- but it runs
 * inside one transaction, `set local role authenticated`, with hand-written
 * JWT claims. get_audience_dashboard, get_music_dashboard and
 * get_promotions_dashboard are all SECURITY INVOKER (D4): the whole point of
 * that choice is that RLS applies INSIDE them, exactly as it would for any
 * other query the caller ran themselves. pgTAP's `set local role` never
 * exercises a real session, a real JWT, or a real second identity of
 * different ownership -- so it cannot prove RLS actually engages here, only
 * that the arithmetic is right once it does. This file is what proves the
 * former, with real signed-in users over the real HTTP stack. No assertion
 * below ever uses `service_role`.
 *
 * Six cases, each in its own `it`, matching the brief:
 *   1. a Station's numbers do not cross -- the cross-Station call raises,
 *      it is never narrowed to the Station the caller does hold;
 *   2. a consolidated call needs reports.consolidated in EVERY Station named
 *      (D3), not just one;
 *   3. the three panels gate independently -- holding one domain's code says
 *      nothing about another;
 *   4. the withheld contract (D13), end to end: took_part is named in
 *      withheld AND absent from cards, both asserted, because a zero would
 *      satisfy neither;
 *   5. the same shape on get_promotions_dashboard: the entry side is
 *      withheld while the prize cycle -- gated by promotions.view alone --
 *      survives;
 *   6. an archived promotion's participations stop reaching a NON-OWNER's
 *      totals, while the Organization's owner still sees them (0044's rule,
 *      inherited through 0053's participations policy) -- deliberately
 *      deferred from Task 5's pgTAP suite, which has no second identity to
 *      prove ownership with.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Wide enough to swallow every fixture's real timestamps below regardless of
// the date this suite happens to run on, so no case has to recompute a
// window relative to "now" just to keep a fixture inside it.
const WINDOW_FROM = '2020-01-01';
const WINDOW_TO = '2030-01-01';
const CUSTOM_WINDOW = { p_preset: 'custom', p_from: WINDOW_FROM, p_to: WINDOW_TO } as const;

interface DashboardCard {
  current?: number;
  previous?: number;
}

/**
 * The shape common to all three payloads. Loosely typed on purpose: each
 * function's Postgres return type is jsonb, so supabase-js can only tell us
 * `Json`, and the point of every assertion below is the PRESENCE or ABSENCE
 * of a key -- which a stricter type would have to declare optional anyway.
 */
interface DashboardPayload {
  cards: Record<string, DashboardCard | undefined>;
  withheld: Array<{ figure: string; needs: string }>;
  [key: string]: unknown;
}

afterAll(cleanupUsers);

describe('dashboard RPCs — the tenant and permission boundary, with real JWTs', () => {
  describe('Case 1: a Station\'s numbers do not cross', () => {
    it('serves A, refuses B, and refuses [A, B] with 42501 — never a payload narrowed to A', async () => {
      const label = `dash-cross-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station B');

      // Real data at A: the failure mode this case exists to catch is a
      // consolidated call that, instead of raising, silently narrows to the
      // Station the caller DOES hold — which would show up here as a real,
      // non-null payload rather than an unconvincing empty one.
      await createMemberAs(customer, customer.companyId, { fullName: `Listener ${label}` });

      // members.view in Station A ONLY — no membership at all in B.
      const delegate = await grantRoleWith(customer, label, ['members.view'], [
        customer.companyId,
      ]);
      const client = await signInAs(delegate.email, delegate.password);

      const okA = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId],
      });
      expect(okA.error).toBeNull();
      expect(okA.data).not.toBeNull();

      const deniedB = await client.rpc('get_audience_dashboard', {
        p_company_ids: [stationB],
      });
      expect(deniedB.error?.code).toBe('42501');
      // Not merely an error code: the response carries no rows/figures at
      // all, which is the other half of "refused, not narrowed".
      expect(deniedB.data).toBeNull();

      const deniedBoth = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId, stationB],
      });
      expect(deniedBoth.error?.code).toBe('42501');
      expect(deniedBoth.data).toBeNull();
    });
  });

  describe('Case 2: a consolidated call needs the code in every Station', () => {
    it('serves [A] but refuses [A, B] with 42501 when reports.consolidated is held only in A', async () => {
      const label = `dash-consolidated-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station B');

      // A second role, holding members.view alone, for the SAME person to
      // hold in Station B — assign_company_role (0017) is what lets one user
      // carry two different roles across two Companies; the invitation flow
      // alone can only ever apply ONE role to every Station it names.
      const roleWeak = await createRoleAs(customer, `Weak-${label}`, ['members.view']);

      const delegate = await grantRoleWith(
        customer,
        label,
        ['members.view', 'reports.consolidated'],
        [customer.companyId],
      );

      const owner = await signInAs(customer.email, customer.password);
      const assigned = await owner.rpc('assign_company_role', {
        p_company_id: stationB,
        p_user_id: delegate.userId,
        p_role_id: roleWeak,
      });
      expect(assigned.error).toBeNull();

      const client = await signInAs(delegate.email, delegate.password);

      const okA = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId],
      });
      expect(okA.error).toBeNull();
      expect(okA.data).not.toBeNull();

      const deniedBoth = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId, stationB],
      });
      expect(deniedBoth.error?.code).toBe('42501');
      expect(deniedBoth.data).toBeNull();
    });
  });

  describe('Case 3: the panel gates are independent', () => {
    it('refuses get_audience_dashboard and serves get_music_dashboard to a music.view-only caller', async () => {
      const label = `dash-independent-${Date.now()}`;
      const customer = await provisionCustomer(label);

      // music.view alone — no members.view at all.
      const delegate = await grantRoleWith(customer, label, ['music.view']);
      const client = await signInAs(delegate.email, delegate.password);

      const audience = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId],
      });
      expect(audience.error?.code).toBe('42501');
      expect(audience.data).toBeNull();

      const music = await client.rpc('get_music_dashboard', {
        p_company_ids: [customer.companyId],
      });
      expect(music.error).toBeNull();
      expect(music.data).not.toBeNull();
    });
  });

  /**
   * Cases 4 and 5 share one fixture shape: a real participation AND a real
   * winner, so that a figure which silently returned 0 instead of being
   * withheld would be caught as WRONG, not merely unconvincing — the same
   * reasoning pickups.test.ts gives for seeding a real winner before proving
   * a refusal. Built fresh per `it`, as owner (bypasses has_permission for
   * their own Organization, the same bypass every other fixture helper in
   * this suite already leans on).
   */
  async function seedParticipationAndWinner(
    customer: ProvisionedCustomer,
    label: string,
  ): Promise<{ promotionId: string; memberId: string }> {
    const owner = await signInAs(customer.email, customer.password);

    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Listener ${label}`,
    });

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
      p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
    });
    if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
    const promotionId = promotion.data as string;

    const link = await owner.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    if (link.error) throw new Error(`link_prize_to_promotion failed: ${link.error.message}`);

    const participated = await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    if (participated.error) {
      throw new Error(`record_participation failed: ${participated.error.message}`);
    }

    const drawn = await owner.rpc('run_draw', { p_promotion_id: promotionId, p_units: null });
    if (drawn.error) throw new Error(`run_draw failed: ${drawn.error.message}`);

    return { promotionId, memberId };
  }

  describe('Case 4: the withheld contract on get_audience_dashboard (D13)', () => {
    it('omits took_part from cards AND names it in withheld for a caller lacking participations.view', async () => {
      const label = `dash-withheld-audience-${Date.now()}`;
      const customer = await provisionCustomer(label);
      await seedParticipationAndWinner(customer, label);

      // members.view (so the panel itself is reachable) and promotions.view
      // (used again by case 5's own version of this caller), but deliberately
      // NOT participations.view.
      const delegate = await grantRoleWith(customer, label, ['members.view', 'promotions.view']);
      const client = await signInAs(delegate.email, delegate.password);

      const result = await client.rpc('get_audience_dashboard', {
        p_company_ids: [customer.companyId],
        ...CUSTOM_WINDOW,
      });
      expect(result.error).toBeNull();
      const payload = result.data as unknown as DashboardPayload;

      expect(payload.withheld).toContainEqual({ figure: 'took_part', needs: 'participations.view' });
      // Both halves of the contract, not one: a zero would satisfy neither
      // "absent from cards" nor "named in withheld", and asserting only the
      // withheld entry would let a zero slip through as if it were absent.
      expect(payload.cards.took_part).toBeUndefined();
    });
  });

  describe('Case 5: the prize cycle survives the same withholding on get_promotions_dashboard', () => {
    it('withholds the entry side while the prize cycle — gated by promotions.view alone — keeps its real figure', async () => {
      const label = `dash-withheld-promotions-${Date.now()}`;
      const customer = await provisionCustomer(label);
      await seedParticipationAndWinner(customer, label);

      const delegate = await grantRoleWith(customer, label, ['members.view', 'promotions.view']);
      const client = await signInAs(delegate.email, delegate.password);

      const result = await client.rpc('get_promotions_dashboard', {
        p_company_ids: [customer.companyId],
        ...CUSTOM_WINDOW,
      });
      expect(result.error).toBeNull();
      const payload = result.data as unknown as DashboardPayload;

      // The entry side: withheld, not zeroed.
      expect(payload.cards.participations).toBeUndefined();
      expect(
        payload.withheld.some((w) => w.figure === 'participations' && w.needs === 'participations.view'),
      ).toBe(true);

      // The prize cycle: present, and genuinely counting the winner
      // seedParticipationAndWinner produced — not merely present as an
      // untouched zero, which would pass whether or not winners was gated
      // correctly at all.
      expect(payload.cards.awarded).toBeDefined();
      expect((payload.cards.awarded as DashboardCard).current).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Case 6: an archived promotion\'s participations do not reach a non-owner\'s totals', () => {
    it('drops the participation figure for a non-owner delegate but holds it for the Organization\'s owner', async () => {
      const label = `dash-archived-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const owner = await signInAs(customer.email, customer.password);

      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Listener ${label}`,
      });

      // A window that has ALREADY ended, so archive_promotion's own guard
      // ("still accepting entries; cancel it before archiving", 0050) never
      // fires and no separate promotions.cancel grant is needed — the same
      // trick pickups.test.ts's own archived-promotion case relies on.
      const starts = new Date(Date.now() - 10 * DAY);
      const ends = new Date(Date.now() - 1 * DAY);
      const promotion = await owner.rpc('create_promotion', {
        p_company_id: customer.companyId,
        p_name: `Promo ${label}`,
        p_starts_at: starts.toISOString(),
        p_ends_at: ends.toISOString(),
      });
      if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
      const promotionId = promotion.data as string;

      const participated = await owner.rpc('record_participation', {
        p_promotion_id: promotionId,
        p_member_id: memberId,
        p_participated_at: new Date(starts.getTime() + HOUR).toISOString(),
        p_source: 'MANUAL',
        p_answers: [],
      });
      if (participated.error) {
        throw new Error(`record_participation failed: ${participated.error.message}`);
      }

      // A genuine delegate: promotions.view (the panel's own gate) AND
      // participations.view (so the entry figure is visible AT ALL before
      // this case's own archival narrows it) — never the owner, because the
      // whole property under test is the gap BETWEEN an owner and a
      // non-owner that 0044's is_owner_of_company opens.
      const delegate = await grantRoleWith(customer, label, [
        'promotions.view',
        'participations.view',
      ]);
      const delegateClient = await signInAs(delegate.email, delegate.password);

      const args = { p_company_ids: [customer.companyId], ...CUSTOM_WINDOW };

      const beforeDelegate = await delegateClient.rpc('get_promotions_dashboard', args);
      expect(beforeDelegate.error).toBeNull();
      const beforePayload = beforeDelegate.data as unknown as DashboardPayload;
      expect((beforePayload.cards.participations as DashboardCard).current).toBe(1);

      const archived = await owner.rpc('archive_promotion', { p_promotion_id: promotionId });
      expect(archived.error).toBeNull();

      // The non-owner: the row drops out of `participations` entirely, via
      // 0053's own policy (`promotion_id in (select id from
      // public.promotions)`, itself filtered by 0044's `deleted_at is null or
      // is_owner_of_company`) — inherited automatically because
      // get_promotions_dashboard is SECURITY INVOKER (D4), never restated by
      // hand inside it.
      const afterDelegate = await delegateClient.rpc('get_promotions_dashboard', args);
      expect(afterDelegate.error).toBeNull();
      const afterPayload = afterDelegate.data as unknown as DashboardPayload;
      expect((afterPayload.cards.participations as DashboardCard).current).toBe(0);

      // The owner: is_owner_of_company admits them to the archived row, so
      // their own total holds exactly where it was.
      const afterOwner = await owner.rpc('get_promotions_dashboard', args);
      expect(afterOwner.error).toBeNull();
      const ownerPayload = afterOwner.data as unknown as DashboardPayload;
      expect((ownerPayload.cards.participations as DashboardCard).current).toBe(1);
    });
  });
});
