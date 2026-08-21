import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_SERVICE_ROLE_KEY, LOCAL_SUPABASE_URL } from '../local-supabase';
import type { Database } from '@/lib/supabase/database.types';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

afterAll(cleanupUsers);

/**
 * Block 28. What pgTAP cannot reach, for the two geography aggregates.
 *
 * 61_places.test.sql proves the key and the cache's shape against a session it
 * sets by hand, as superuser with a null `auth.uid()`, where RLS never applies
 * and `has_permission` has no actor to resolve. Both functions here are
 * SECURITY INVOKER (0215) — the whole point of that choice is that RLS applies
 * INSIDE them — so only a real JWT, a real role and a real membership can prove
 * the boundary actually engages. No assertion below uses `service_role` except
 * to place coordinates in the cache, which is the worker's job and not the
 * subject of any case.
 *
 * Per this directory's standing rule the actor is a non-owner DELEGATE in every
 * case: Block 1c shipped two defects that thirteen reviews missed because every
 * scenario had the owner driving, and the owner's bypass hid the delegate's
 * failure.
 */

const WINDOW = { p_preset: 'custom', p_from: '2020-01-01', p_to: '2030-01-01' } as const;

interface GeographyPayload {
  places: { key: string; city: string | null; count: number }[];
  with_place: number;
  total: number;
}

/** Block 30e's map carries two more fields per place, and a withheld array. */
interface PromotionsGeographyPayload extends GeographyPayload {
  places: {
    key: string;
    city: string | null;
    count: number;
    top_promotion: string | null;
    top_promotion_count: number | null;
  }[];
  withheld: { figure: string; needs: string }[];
}

/**
 * Runs the worker's own two steps — sweep the members table for places, then
 * write a coordinate for each — through the service role, because that is who
 * the worker is. Nothing under test here; it is the fixture that makes a place
 * resolvable, and without it every map is legitimately empty.
 */
/**
 * THE SERVICE ROLE, not the platform admin's client. 0214 grants the three place
 * doors to service_role alone, because the worker is their only caller and there
 * is no user to check — a platform admin is still an `authenticated` session and
 * is refused, which is the correct answer and was this file's first failure.
 *
 * ONE CLIENT FOR THE FILE, not one per call. Each `createClient` opens its own
 * fetch and auth machinery, and this suite's `Worker exited unexpectedly` crash
 * lands in per-file teardown — so a helper that minted a fresh client on every
 * invocation was adding three more things for that teardown to close, in the
 * newest file in the suite, for no benefit.
 */
const service = createClient<Database>(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function resolveAllPlaces(_customer: ProvisionedCustomer): Promise<void> {
  const admin = service;
  const { error: sweepError } = await admin.rpc('enqueue_missing_places', { p_limit: 1000 });
  if (sweepError) throw new Error(`enqueue_missing_places failed: ${sweepError.message}`);

  const { data: claimed, error: claimError } = await admin.rpc('claim_places_to_geocode', {
    p_limit: 200,
  });
  if (claimError) throw new Error(`claim_places_to_geocode failed: ${claimError.message}`);

  for (const place of claimed ?? []) {
    const { error } = await admin.rpc('record_place_geocode', {
      p_id: place.id,
      // A real coordinate is not needed and would be a fiction anyway; what
      // every case below reads is the GROUPING, not the position.
      p_latitude: -2.53,
      p_longitude: -44.31,
      p_precision: 'neighbourhood',
    });
    if (error) throw new Error(`record_place_geocode failed: ${error.message}`);
  }
}

describe('the geography aggregates', () => {
  it('does not show one Station s places to another, inside the same Organization', async () => {
    const label = `geo-isolation-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // One listener per Station, in DIFFERENT cities, so a leak is visible as a
    // place rather than only as a count.
    const here = await createMemberAs(customer, customer.companyId, {
      fullName: `Here ${label}`,
    });
    const there = await createMemberAs(customer, otherCompanyId, {
      fullName: `There ${label}`,
    });

    const owner = await signInAs(customer.email, customer.password);
    await owner.rpc('update_member', {
      p_member_id: here,
      p_full_name: `Here ${label}`,
      p_city: 'São Luís',
      p_state: 'MA',
      p_country: 'BR',
    });
    await owner.rpc('update_member', {
      p_member_id: there,
      p_full_name: `There ${label}`,
      p_city: 'Santos',
      p_state: 'SP',
      p_country: 'BR',
    });

    await resolveAllPlaces(customer);

    // A delegate who can see Station A only.
    const delegate = await grantRoleWith(customer, `${label}-a`, ['members.view'], [
      customer.companyId,
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_audience_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });
    expect(error).toBeNull();

    const payload = data as unknown as GeographyPayload;
    const cities = payload.places.map((p) => p.city);
    expect(cities).toContain('São Luís');
    // THE ASSERTION THAT MATTERS. geocoded_places is readable by every signed-in
    // caller by design (0214) — it holds no tenant column — so the other
    // Station's place row is genuinely visible to this delegate. What must not
    // be visible is that any of THEIR listeners live there, and that is what the
    // join through members and the caller's own RLS decides.
    expect(cities).not.toContain('Santos');
    expect(payload.total).toBe(1);
  });

  it('refuses a second Station to a caller without reports.consolidated, and never narrows to the one they hold', async () => {
    const label = `geo-consolidated-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // members.view in BOTH, reports.consolidated in NEITHER.
    const delegate = await grantRoleWith(customer, `${label}-both`, ['members.view'], [
      customer.companyId,
      otherCompanyId,
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_audience_geography', {
      p_company_ids: [customer.companyId, otherCompanyId],
      ...WINDOW,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(error!.message).toMatch(/reports\.consolidated/);
    // NEVER NARROWED. A function that quietly answered for the one Station the
    // caller does hold would be the more "helpful" failure and the wrong one:
    // the caller asked about two and would read the answer as covering both.
    expect(data).toBeNull();
  });

  it('answers for two Stations once reports.consolidated is held in both', async () => {
    const label = `geo-allowed-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    const here = await createMemberAs(customer, customer.companyId, { fullName: `H ${label}` });
    const there = await createMemberAs(customer, otherCompanyId, { fullName: `T ${label}` });
    const owner = await signInAs(customer.email, customer.password);
    for (const [id, city, state] of [
      [here, 'São Luís', 'MA'],
      [there, 'Santos', 'SP'],
    ] as const) {
      await owner.rpc('update_member', {
        p_member_id: id,
        p_full_name: `${city} ${label}`,
        p_city: city,
        p_state: state,
        p_country: 'BR',
      });
    }
    await resolveAllPlaces(customer);

    const delegate = await grantRoleWith(
      customer,
      `${label}-cons`,
      ['members.view', 'reports.consolidated'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_audience_geography', {
      p_company_ids: [customer.companyId, otherCompanyId],
      ...WINDOW,
    });
    expect(error).toBeNull();

    const payload = data as unknown as GeographyPayload;
    expect(payload.places.map((p) => p.city).sort()).toEqual(['Santos', 'São Luís']);
    // Two listeners across two Stations, not four: `member_place` deduplicates
    // by member before anything is counted, so a listener linked to both
    // Stations of a consolidated view is one person on one dot.
    expect(payload.total).toBe(2);
  });

  it('counts exactly the population the Listeners card counts — design D11', async () => {
    // THE ASSERTION THAT PINS D11, and the one that would fail the moment
    // somebody "improved" either count. Block 8a's D12b makes "every figure on
    // this panel counts the same people" a rule; a map counting a flow beside a
    // card counting a stock is what that rule exists to prevent, and the two
    // are only equal because 0215's `link` CTE is copied from 0118 rather than
    // rewritten.
    const label = `geo-d11-${Date.now()}`;
    const customer = await provisionCustomer(label);

    const withCity = await createMemberAs(customer, customer.companyId, {
      fullName: `Placed ${label}`,
    });
    // A second listener with NO city at all. They count towards `total` and
    // must not appear on the map — which is the whole reason the coverage line
    // carries two numbers rather than one.
    await createMemberAs(customer, customer.companyId, { fullName: `Unplaced ${label}` });

    const owner = await signInAs(customer.email, customer.password);
    await owner.rpc('update_member', {
      p_member_id: withCity,
      p_full_name: `Placed ${label}`,
      p_city: 'São Luís',
      p_state: 'MA',
      p_country: 'BR',
    });
    await resolveAllPlaces(customer);

    const delegate = await grantRoleWith(customer, `${label}-d11`, ['members.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const [geography, dashboard] = await Promise.all([
      client.rpc('get_audience_geography', { p_company_ids: [customer.companyId], ...WINDOW }),
      client.rpc('get_audience_dashboard', { p_company_ids: [customer.companyId], ...WINDOW }),
    ]);
    expect(geography.error).toBeNull();
    expect(dashboard.error).toBeNull();

    const payload = geography.data as unknown as GeographyPayload;
    const cards = (dashboard.data as unknown as { cards: { listeners?: { current?: number } } })
      .cards;

    expect(payload.total).toBe(cards.listeners?.current);
    expect(payload.total).toBe(2);
    // One of the two is on the map. Asserted as well as the equality above,
    // because `with_place === total` would satisfy the equality while proving
    // the coverage line says nothing.
    expect(payload.with_place).toBe(1);
  });

  it('gates the music map on music.view, independently of the audience one', async () => {
    const label = `geo-music-${Date.now()}`;
    const customer = await provisionCustomer(label);

    // members.view and NOT music.view. Holding one domain's code says nothing
    // about another — the same independence dashboards.test.ts's own case 3
    // proves for the three panels.
    const delegate = await grantRoleWith(customer, `${label}-audience-only`, ['members.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const audience = await client.rpc('get_audience_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });
    expect(audience.error).toBeNull();

    const music = await client.rpc('get_music_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });
    expect(music.error).not.toBeNull();
    expect(music.error!.code).toBe('42501');
    expect(music.error!.message).toMatch(/music\.view/);
    expect(music.data).toBeNull();
  });

  /**
   * Block 30e, item 19. The promotions map, which counts a different population
   * from both of its neighbours -- entries in the window rather than listeners as
   * of its end -- and therefore has to agree with a different card.
   */
  it('counts exactly the population the participations card counts, and names the promotion most played in a place - design D11', async () => {
    const label = `geo-promo-d11-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);

    const promotionOf = async (name: string) => {
      const { data, error } = await owner.rpc('create_promotion', {
        p_company_id: customer.companyId,
        p_name: `${name} ${label}`,
        p_starts_at: new Date(Date.now() - 86_400_000).toISOString(),
        p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (error) throw new Error(`create_promotion failed: ${error.message}`);
      return data as unknown as string;
    };

    const busier = await promotionOf('Busier');
    const quieter = await promotionOf('Quieter');

    const listenerIn = async (city: string | null, name: string) => {
      const id = await createMemberAs(customer, customer.companyId, {
        fullName: `${name} ${label}`,
      });
      if (city) {
        await owner.rpc('update_member', {
          p_member_id: id,
          p_full_name: `${name} ${label}`,
          p_city: city,
          p_state: 'MA',
          p_country: 'BR',
        });
      }
      return id;
    };

    // Three listeners in one city and one with no place at all. The unplaced one
    // is what makes `with_place` and `total` different numbers -- without it the
    // equality below would hold while the coverage line said nothing.
    const entries: [member: string, promotion: string][] = [
      [await listenerIn('São Luís', 'Placed A'), busier],
      [await listenerIn('São Luís', 'Placed B'), busier],
      [await listenerIn('São Luís', 'Placed C'), quieter],
      [await listenerIn(null, 'Unplaced'), busier],
    ];

    for (const [member, promotion] of entries) {
      const { error } = await owner.rpc('record_participation', {
        p_promotion_id: promotion,
        p_member_id: member,
        p_participated_at: new Date().toISOString(),
        p_source: 'MANUAL',
      });
      if (error) throw new Error(`record_participation failed: ${error.message}`);
    }

    await resolveAllPlaces(customer);

    const delegate = await grantRoleWith(customer, `${label}-full`, [
      'promotions.view',
      'participations.view',
      'members.view',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const [geography, dashboard] = await Promise.all([
      client.rpc('get_promotions_geography', { p_company_ids: [customer.companyId], ...WINDOW }),
      client.rpc('get_promotions_dashboard', { p_company_ids: [customer.companyId], ...WINDOW }),
    ]);
    expect(geography.error).toBeNull();
    expect(dashboard.error).toBeNull();

    const payload = geography.data as unknown as PromotionsGeographyPayload;
    const cards = (
      dashboard.data as unknown as { cards: { participations?: { current?: number } } }
    ).cards;

    // THE ASSERTION THAT PINS D11, and the one that fails the moment somebody
    // "improves" either count -- by filtering this map to VALID entries, say,
    // which is the plausible change that would break it.
    expect(payload.total).toBe(cards.participations?.current);
    expect(payload.total).toBe(4);
    // Three of the four reached a coordinate. Asserted separately, because
    // `with_place === total` would satisfy the equality above while proving the
    // coverage line says nothing.
    expect(payload.with_place).toBe(3);

    expect(payload.places).toHaveLength(1);
    expect(payload.places[0]?.count).toBe(3);
    // The promotion most played THERE -- two entries against one -- which is what
    // makes this map worth more than a count.
    expect(payload.places[0]?.top_promotion).toBe(`Busier ${label}`);
    expect(payload.places[0]?.top_promotion_count).toBe(2);
    expect(payload.withheld).toEqual([]);
  });

  /**
   * D12, both halves. Neither permission refuses, because refusing would take
   * down a panel whose cards the caller may legitimately read; and neither may
   * produce an EMPTY MAP, because an empty map claims the Station has no
   * geography rather than saying the caller may not see it.
   */
  it('withholds the promotions map without participations.view, naming what is missing', async () => {
    const label = `geo-promo-noentries-${Date.now()}`;
    const customer = await provisionCustomer(label);

    const delegate = await grantRoleWith(customer, `${label}-noentries`, [
      'promotions.view',
      'members.view',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_promotions_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });
    expect(error).toBeNull();

    const payload = data as unknown as PromotionsGeographyPayload;
    expect(payload.withheld).toEqual([{ figure: 'places', needs: 'participations.view' }]);
    expect(payload.places).toEqual([]);
  });

  it('withholds it without members.view too, because the map plots the listeners behind the entries', async () => {
    const label = `geo-promo-nomembers-${Date.now()}`;
    const customer = await provisionCustomer(label);

    // THE CASE THAT WOULD OTHERWISE FAIL SILENTLY. This function is SECURITY
    // INVOKER, so without members.view the caller's own RLS cuts every listener
    // and the map comes back empty -- under a coverage line still naming a total.
    const delegate = await grantRoleWith(customer, `${label}-nomembers`, [
      'promotions.view',
      'participations.view',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_promotions_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });
    expect(error).toBeNull();

    const payload = data as unknown as PromotionsGeographyPayload;
    expect(payload.withheld).toEqual([{ figure: 'places', needs: 'members.view' }]);
    expect(payload.places).toEqual([]);
  });

  it('refuses the promotions map without promotions.view, which is the panel own gate', async () => {
    const label = `geo-promo-refused-${Date.now()}`;
    const customer = await provisionCustomer(label);

    const delegate = await grantRoleWith(customer, `${label}-nopromos`, [
      'participations.view',
      'members.view',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_promotions_geography', {
      p_company_ids: [customer.companyId],
      ...WINDOW,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(error!.message).toMatch(/promotions\.view/);
    expect(data).toBeNull();
  });

  it('refuses an empty Station list rather than answering for everything', async () => {
    const label = `geo-empty-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, `${label}-empty`, ['members.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client.rpc('get_audience_geography', {
      p_company_ids: [],
      ...WINDOW,
    });
    // 22023, the same refusal 0118 gives. The alternative — treating an empty
    // array as "all of them" — is the shape of bug that turns a control which
    // can produce an empty selection into a cross-tenant read.
    expect(error).not.toBeNull();
    expect(error!.code).toBe('22023');
    expect(data).toBeNull();
  });
});
