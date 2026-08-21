import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { BusinessRuleError, ConflictError, InternalError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import type { Database } from '@/lib/supabase/database.types';
import type { VendorFormInput } from '@/schemas/vendors';

/**
 * Block 24, item 7. Prize suppliers, read through PostgREST and written through
 * 0199's doors.
 *
 * READS GO STRAIGHT TO THE TABLE, like shows and songs and unlike promotions:
 * `vendors` carries one select policy gated on `inventory.view`, so RLS already
 * scopes every row to the Stations the caller can see, and every filter this
 * screen has is expressible as a column comparison. A list RPC would be a second
 * pattern for a job this codebase already has one for.
 *
 * WRITES CANNOT: the table has no insert or update policy at all. `save_vendor`
 * and `archive_vendor` are SECURITY DEFINER and re-check `inventory.catalogue`
 * against auth.uid().
 *
 * THERE IS NO "SHOW ARCHIVED" READ ANYWHERE HERE, and that is `0198`'s policy
 * rather than an omission: it filters `deleted_at is null`, so an archived
 * vendor is not merely hidden from a list, it is unreadable through RLS for
 * every caller. The same is true of prizes and of the whole music catalogue —
 * see `0099`'s own comment, which found this the expensive way.
 */

function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const VENDOR_PAGE_SIZE = 25;
export const VENDOR_SEARCH_MAX_LENGTH = 100;

export type VendorSortKey = 'name' | 'created';

export interface VendorSummary {
  id: string;
  /**
   * The Station the vendor belongs to, carried on the row rather than taken from
   * whichever Station the list happens to be showing: a record opened from a
   * pasted `?record=` link may not be one of them, and `save_vendor` scopes its
   * update by company — a mismatch would come back as "vendor not found".
   */
  companyId: string;
  name: string;
  legalName: string | null;
  document: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  website: string | null;
  notes: string | null;
  createdAt: string;
}

export interface VendorListParams {
  companyId: string;
  /** Over the name, the document and the contact — the three things somebody holding an invoice has to hand. */
  search?: string;
  /** One city, when the filter bar narrows to it. */
  city?: string;
  sort: VendorSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface VendorListPage {
  rows: VendorSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

const VENDOR_COLUMNS =
  'id,company_id,name,legal_name,document,contact_name,phone,email,' +
  'address_line,city,state,postal_code,website,notes,created_at';

type VendorRow = {
  id: string;
  company_id: string;
  name: string;
  legal_name: string | null;
  document: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  website: string | null;
  notes: string | null;
  created_at: string;
};

function toSummary(row: VendorRow): VendorSummary {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    legalName: row.legal_name,
    document: row.document,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    addressLine: row.address_line,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    website: row.website,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function listVendorsPage(params: VendorListParams): Promise<VendorListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'name' ? 'name' : 'created_at';
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('vendors')
      .select(VENDOR_COLUMNS, options)
      .eq('company_id', params.companyId)
      // Redundant against 0198's own policy, and kept for the reason every
      // other read in this codebase keeps it: a policy is the boundary, and a
      // query that also states its intent survives a policy being rewritten.
      .is('deleted_at', null);

    if (params.city) q = q.eq('city', params.city);

    if (params.search) {
      const term = escapeLikePattern(params.search.slice(0, VENDOR_SEARCH_MAX_LENGTH));
      // The three fields somebody holding an invoice actually has: who it says,
      // the number on it, and the person they spoke to. `quoteForOrFilter`
      // because an `or` filter is a comma-separated expression and a comma in
      // the term would otherwise become a fourth condition.
      const quoted = quoteForOrFilter(`%${term}%`);
      q = q.or(`name.ilike.${quoted},document.ilike.${quoted},contact_name.ilike.${quoted}`);
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // Neither sort column is nullable, so there is no null region for a cursor
    // to cross into — the same reasoning listSongsPage (services/music.ts) records.
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(VENDOR_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read vendors: ${error.message}`);

  const rows = (data ?? []) as unknown as VendorRow[];

  const { rows: page, nextCursor, previousCursor } = keysetPage(rows, {
    pageSize: VENDOR_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'name' ? row.name : row.created_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count vendors: ${countError.message}`);

  return {
    rows: page.map(toSummary),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/**
 * Every city this Station's suppliers are in, for the filter bar's select.
 *
 * A read of its own rather than deriving the list from the page on screen: a
 * filter offering only the cities of page one is a filter that changes what it
 * offers as the operator pages, which is worse than no filter.
 */
export async function listVendorCities(companyId: string): Promise<string[]> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('vendors')
    .select('city')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .not('city', 'is', null)
    .order('city');

  if (error) throw new InternalError(`Could not read vendor cities: ${error.message}`);

  // Deduplicated here rather than by a `distinct` PostgREST cannot express.
  // A Station's supplier list is tens of rows, so this is one small read and a
  // Set, not a scan worth pushing into SQL.
  return [...new Set((data ?? []).map((row) => row.city).filter((city): city is string => !!city))];
}

export interface VendorOption {
  id: string;
  name: string;
}

/**
 * Suppliers a stock entry may name (Block 24, item 8's picker).
 *
 * A light read rather than the paginated one: the picker needs a name to choose
 * from, not an address or a total count — the same reasoning
 * `listReservableShows` gives for its own equivalent.
 *
 * ARCHIVED ONES ARE ABSENT, which is what archiving is for here: `0198`'s policy
 * filters them, and `record_stock_entry` refuses one anyway (`0200`), so the
 * picker and the door agree without either restating the other's rule.
 */
export async function listVendorOptions(companyId: string): Promise<VendorOption[]> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name');

  if (error) throw new InternalError(`Could not read vendors: ${error.message}`);
  return data ?? [];
}

/** One vendor by id. RLS already scopes this, so an unreachable one comes back null. */
export async function getVendorById(vendorId: string): Promise<VendorSummary | null> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('vendors')
    .select(VENDOR_COLUMNS)
    .eq('id', vendorId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the vendor: ${error.message}`);
  return data ? toSummary(data as unknown as VendorRow) : null;
}

function mapVendorError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  // vendors_name_unique. The constraint's own message names an index rather than
  // a supplier, so the caller turns this into a sentence — see actions.ts.
  if (code === '23505') return new ConflictError(message);
  if (code === '22023') return new BusinessRuleError(message);
  return new InternalError(message);
}

export async function saveVendor(input: VendorFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_vendor', {
    p_company_id: input.companyId,
    p_name: input.name,
    p_legal_name: input.legalName,
    p_document: input.document,
    p_contact_name: input.contactName,
    p_phone: input.phone,
    p_email: input.email,
    p_address_line: input.addressLine,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_website: input.website,
    p_notes: input.notes,
    // Absent rather than null when registering: the RPC's `default null` on
    // p_vendor_id is what tells it to create instead of replace.
    p_vendor_id: input.vendorId ?? undefined,
  });

  if (error) throw mapVendorError(error.code, error.message);
  return data as string;
}

export async function archiveVendor(vendorId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_vendor', {
    p_vendor_id: vendorId,
  });
  if (error) throw mapVendorError(error.code, error.message);
}
