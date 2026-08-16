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

/**
 * Runs the worker's own two steps — sweep the members table for places, then
 * write a coordinate for each — through the service role, because that is who
 * the worker is. Nothing under test here; it is the fixture that makes a place
 * resolvable, and without it every map is legitimately empty.
 */
async function resolveAllPlaces(_customer: ProvisionedCustomer): Promise<void> {
  // THE SERVICE ROLE, not the platform admin's client. 0214 grants the three
  // place doors to service_role alone, because the worker is their only caller
  // and there is no user to check — a platform admin is still an `authenticated`
  // session and is refused, which is the correct answer and was this file's
  // first failure.
  const admin = createClient<Database>(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
