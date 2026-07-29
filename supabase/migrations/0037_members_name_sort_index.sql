-- The index the audience list's name sort actually uses.
--
-- Block 3b's plan and spec both say "sorting by name must order by the same
-- expression the index uses", pointing at members_name_idx (0031), which is on
-- (organization_id, lower(full_name)). Building the screen showed that
-- instruction cannot be followed through this stack: PostgREST orders by
-- columns, not expressions, so `order=full_name.asc` is the only ordering the
-- audience query can ask for — and the keyset cursor has to COMPARE the same
-- expression it ORDERS by, so a lower() sort would need a lower() comparison
-- PostgREST equally cannot express. Ordering by lower(full_name) and comparing
-- raw full_name would not just miss the index; it would page wrongly wherever
-- the two orderings disagree, which is any pair of names differing in case.
--
-- So the sort stays on the raw column and this index matches it exactly,
-- including the id tiebreak every keyset ordering in this block carries.
-- members_name_idx (0031) is left alone: it serves lookups by name, and the
-- unique indexes above it are what enforce identity.
--
-- No NULLS ordering is specified, deliberately. The audience query sends no
-- `nullsfirst` either, so both fall to the same Postgres default — ASC puts
-- NULLs last, DESC puts them first — and this one index is then ordered
-- correctly for a forward scan of the ascending sort and a backward scan of
-- the descending one. Asking for NULLS LAST in both directions, which an
-- earlier draft of the service did, would have left the descending sort with
-- no usable index at all.
create index members_name_sort_idx
  on public.members (organization_id, full_name, id)
  where deleted_at is null;

comment on index public.members_name_sort_idx is
  'Keyset sort by name on the audience list (Block 3b): (organization_id, full_name, id), raw column and not lower(full_name), because PostgREST can neither order by nor compare an expression — see this migration''s own comment. Partial on deleted_at is null, like every other index on members.';
