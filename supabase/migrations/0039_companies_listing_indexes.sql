-- The index the admin customers console pages on (Block 3b).
--
-- companies_organization_idx (0003) is on (organization_id), which is the
-- right index for a tenant-scoped read and the wrong one for this screen:
-- the customers console is platform-wide by design, has no Organization to
-- cut on, and orders by (created_at, id) — the ordering its keyset cursor
-- compares.
--
-- Partial on `deleted_at is null`, matching that screen's query, which since
-- this block filters archived Stations out rather than rendering suspend and
-- reactivate controls beside rows where neither does anything.
create index companies_created_at_idx
  on public.companies (created_at, id)
  where deleted_at is null;

comment on index public.companies_created_at_idx is
  'Keyset paging on the platform-wide admin customers console (Block 3b): (created_at, id), newest first. Not tenant-scoped — that is what companies_organization_idx (0003) is for.';
