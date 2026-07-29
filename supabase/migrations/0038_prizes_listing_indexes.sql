-- The indexes the inventory list's two sorts use (Block 3b).
--
-- prizes_company_idx (0025) is on (company_id) alone, which narrows to the
-- Station but leaves the ordering to a sort node — and the keyset cursor
-- compares (name, id) or (created_at, id), so the index has to carry the
-- tiebreak or every page boundary is a sort of the whole Station's catalogue.
--
-- Both partial on `deleted_at is null`, matching the list query and 0025's own
-- convention. Neither specifies a NULLS ordering: the query sends no
-- `nullsfirst` either, so ascending scans forward and descending scans
-- backward over the same index. Neither sort column is nullable in any case
-- (0025: `name text not null`, `created_at timestamptz not null`), so unlike
-- members.full_name there is no null region here for a cursor to cross.
create index prizes_name_sort_idx
  on public.prizes (company_id, name, id)
  where deleted_at is null;

create index prizes_created_at_idx
  on public.prizes (company_id, created_at, id)
  where deleted_at is null;

comment on index public.prizes_name_sort_idx is
  'Keyset sort by name on the inventory list (Block 3b): (company_id, name, id), carrying the id tiebreak every keyset ordering in this block uses.';
comment on index public.prizes_created_at_idx is
  'Keyset sort by registration date on the inventory list (Block 3b): (company_id, created_at, id).';
