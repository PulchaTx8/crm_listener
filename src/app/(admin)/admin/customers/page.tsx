import { createUserClient } from '@/lib/supabase/user-client';
import { decodeCursor, keysetFilter, keysetPage } from '@/lib/keyset';
import { escapeLikePattern } from '@/lib/postgrest';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageControls } from '@/components/ui/table';
import { addCompanyAction, suspendAction, reactivateAction } from './actions';
import { ProvisionForm, RegenerateForm } from './credential-forms';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/** One page of customers. Newest first: an admin comes here about somebody they just provisioned. */
const CUSTOMER_PAGE_SIZE = 25;

/** The one bound on this screen's name search — nothing downstream applies one for it. */
const CUSTOMER_SEARCH_MAX_LENGTH = 100;

/**
 * This screen deliberately shows NO total, unlike the audience and inventory
 * lists. Those are cut to one Organization by RLS before they touch disk, so
 * an exact count is cheap; this one is platform-wide by design, and it is an
 * operator's tool rather than a screen that answers "how many" (spec §2).
 */
function customersHref(
  search: string | undefined,
  cursor?: { side: 'after' | 'before'; value: string },
): string {
  const query = new URLSearchParams();
  if (search) query.set('q', search);
  if (cursor) query.set(cursor.side, cursor.value);
  const rest = query.toString();
  return rest ? `/admin/customers?${rest}` : '/admin/customers';
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ stationError?: string; q?: string; after?: string; before?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createUserClient();

  const search = params.q?.trim().slice(0, CUSTOMER_SEARCH_MAX_LENGTH) || undefined;
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(params.before ?? params.after);
  const walkingBack = Boolean(params.before) && cursor !== null;
  // Newest first, so walking back reads oldest-first and the rows are turned
  // around afterwards (keysetPage).
  const ascending = walkingBack;

  let companiesQuery = supabase
    .from('companies')
    .select('id, name, status, suspension_reason, created_at, organization_id')
    // Archived Companies were listed beside live ones, unlike every other list
    // in the project — and an archived Station cannot be suspended or
    // reactivated, so the controls rendered next to it did nothing.
    .is('deleted_at', null);

  if (search) {
    companiesQuery = companiesQuery.ilike('name', `%${escapeLikePattern(search)}%`);
  }

  companiesQuery = companiesQuery.order('created_at', { ascending });
  if (cursor) {
    // created_at is not null, so there is no null region for a cursor to cross
    // here: nullsLast is false for that reason, not by accident.
    companiesQuery = companiesQuery.or(
      keysetFilter('created_at', ascending ? 'asc' : 'desc', cursor, false),
    );
  }
  companiesQuery = companiesQuery.order('id', { ascending });

  const { data: fetched, error: companiesError } = await companiesQuery.limit(
    CUSTOMER_PAGE_SIZE + 1,
  );

  // Previously dropped entirely, unlike the owners/profiles reads below — a
  // failed read rendered as "No company provisioned yet." to a platform
  // admin, indistinguishable from the genuinely-empty case (block-1c final
  // review, Minor 3).
  if (companiesError) logger.error({ err: companiesError }, 'could not load companies');

  const {
    rows: companies,
    nextCursor,
    previousCursor,
  } = keysetPage(fetched ?? [], {
    pageSize: CUSTOMER_PAGE_SIZE,
    walkingBack,
    hadCursor: cursor !== null,
    cursorFor: (row) => ({ value: row.created_at, id: row.id }),
  });

  // The owner of each Company's Organization, so a provisional password can be
  // reissued without hunting for the user by hand. Block 1c stopped giving the
  // owner a company_memberships row — they reach every Station by ownership —
  // so the owner now comes from organization_memberships, keyed by
  // organization_id rather than company_id, and matched to each company below.
  //
  // Two queries joined in JS rather than one PostgREST embed: resource
  // embedding needs a foreign key between the two tables, and there is none.
  // organization_memberships.user_id and profiles.id both reference
  // auth.users(id), which does not give PostgREST a path from one to the
  // other — the embed fails with PGRST200 and returns no rows at all.
  // Block 1c allows more than one owner per Organization. Ordered by
  // created_at so which one is "the" displayed owner — and which account the
  // password-reset form below targets — is stable across renders rather than
  // depending on whatever order Postgres happens to return rows in.
  //
  // Scoped to the Organizations ON THIS PAGE since Block 3b: this read every
  // owner the platform had ever had in order to name twenty-five of them.
  const organizationIds = [...new Set(companies.map((c) => c.organization_id))];
  const { data: owners, error: ownersError } = organizationIds.length
    ? await supabase
        .from('organization_memberships')
        .select('organization_id, user_id')
        .eq('role', 'owner')
        .in('organization_id', organizationIds)
        .order('created_at', { ascending: true })
    : { data: [], error: null };

  if (ownersError) logger.error({ err: ownersError }, 'could not load company owners');

  const ownerUserIds = [...new Set((owners ?? []).map((o) => o.user_id))];

  // Batched, not one `.in(...)` across every owner this platform has ever
  // provisioned: PostgREST folds an `.in()` filter into the request's query
  // string, and enough owners push that string past the server's URI-length
  // limit — a real 414 this project's own local stack started returning once
  // it had accumulated 268 owners across its development history. That error
  // was being logged and swallowed exactly like every other read on this
  // page, so the console never showed it — it silently rendered every
  // "Owner: " line with a blank e-mail instead, for every Company, not just
  // one. Chunking keeps each request's IN-list short regardless of how many
  // Organizations exist, rather than merely postponing the same failure to a
  // higher count.
  const OWNER_PROFILE_BATCH_SIZE = 100;
  const ownerProfiles: { id: string; email: string }[] = [];
  for (let i = 0; i < ownerUserIds.length; i += OWNER_PROFILE_BATCH_SIZE) {
    const batch = ownerUserIds.slice(i, i + OWNER_PROFILE_BATCH_SIZE);
    const { data: batchProfiles, error: batchError } = await supabase
      .from('profiles')
      .select('id, email')
      .in('id', batch);
    if (batchError) {
      logger.error({ err: batchError }, 'could not load a batch of owner profiles');
      continue;
    }
    ownerProfiles.push(...(batchProfiles ?? []));
  }

  const emailByUser = new Map(ownerProfiles.map((p) => [p.id, p.email]));

  const ownerByOrganization = new Map<string, { userId: string; email: string }>();
  for (const row of owners ?? []) {
    if (ownerByOrganization.has(row.organization_id)) continue;
    ownerByOrganization.set(row.organization_id, {
      userId: row.user_id,
      email: emailByUser.get(row.user_id) ?? '',
    });
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description="Provision a new customer, or manage an existing subscription."
      />

      {params.stationError ? (
        <p className="text-sm text-destructive">
          Could not add the Station. Check the name and try again.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle>Provision a customer</CardTitle>
            <CardDescription>
              Creates the organization, the station and the owner account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProvisionForm />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3">
          {/* A plain GET form: submitting it is a navigation, which is all this
              needs, and it carries no cursor — a search is a new list, so it
              starts at the beginning of one. */}
          <form method="get" action="/admin/customers" className="flex flex-wrap items-end gap-2">
            <Input
              type="search"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search by Station name"
              aria-label="Search customers by Station name"
              className="h-9 w-64 text-sm"
              data-testid="customer-search-input"
            />
            <Button type="submit" variant="outline" className="h-9">
              Search
            </Button>
          </form>

          {companies.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">
                  {search ? 'No customer matches this search.' : 'No company provisioned yet.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            companies.map((c) => {
              const owner = ownerByOrganization.get(c.organization_id);
              return (
                <Card key={c.id} data-testid="company-row">
                  <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{c.name}</span>
                        <span
                          className={
                            c.status === 'active'
                              ? 'w-fit rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary'
                              : 'w-fit rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
                          }
                        >
                          {c.status}
                          {c.suspension_reason ? ` — ${c.suspension_reason}` : ''}
                        </span>
                      </div>
                      {c.status === 'active' ? (
                        <form action={suspendAction} className="flex items-center gap-2">
                          <input type="hidden" name="companyId" value={c.id} />
                          <Input name="reason" placeholder="Reason" className="h-9 w-40 text-sm" />
                          <Button type="submit" variant="outline">
                            Suspend
                          </Button>
                        </form>
                      ) : (
                        <form action={reactivateAction}>
                          <input type="hidden" name="companyId" value={c.id} />
                          <Button type="submit" variant="outline">
                            Reactivate
                          </Button>
                        </form>
                      )}
                    </div>
                    <div className="flex flex-col gap-3 border-t pt-4">
                      {owner ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">
                            Owner: {owner.email}
                          </span>
                          <RegenerateForm userId={owner.userId} email={owner.email} />
                        </div>
                      ) : null}
                      {/* This Organization can hold more than one Station (Block
                          1c) — add_company is platform-admin only, which is why
                          the form lives here rather than on the customer's own
                          screens. organizationId comes from this row, not from
                          a select, since every row already belongs to one. */}
                      <form
                        action={addCompanyAction}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="organizationId" value={c.organization_id} />
                        <Input
                          name="name"
                          placeholder="New Station name"
                          required
                          className="h-9 w-48 text-sm"
                        />
                        <Button type="submit" variant="outline">
                          Add Station
                        </Button>
                      </form>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* No total, on purpose — see customersHref's own comment. */}
          <PageControls
            label="Newest customers first"
            previousHref={
              previousCursor
                ? customersHref(search, { side: 'before', value: previousCursor })
                : null
            }
            nextHref={nextCursor ? customersHref(search, { side: 'after', value: nextCursor }) : null}
          />
        </div>
      </div>
    </>
  );
}
