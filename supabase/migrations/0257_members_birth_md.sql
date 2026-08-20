-- supabase/migrations/0257_members_birth_md.sql

-- Block 30b, D2/D3. The day of the year a listener was born, so that "whose
-- birthday falls in this window" can be asked of an index instead of of every
-- row in the Organization.
--
-- A BIRTHDAY IS NOT A BIRTH DATE, and that distinction is the whole reason this
-- column exists. "Born between two dates" is already answerable on this screen:
-- the age band converts a band into a birth_date range and leans on
-- members_birth_date_idx (0036). What could NOT be asked was the question
-- somebody has before sending a greeting -- who has a birthday next week --
-- because that ignores the year.
--
-- GENERATED, NOT MAINTAINED. The same device phone_normalized and
-- email_normalized already are on this table, for the reason 0031 states in
-- writing: "a normalisation applied by whoever remembers is a normalisation
-- that drifts". A month-and-day derived in the browser, in the service and in
-- SQL would be three places to disagree.
--
-- A COLUMN RATHER THAN AN EXPRESSION INDEX, because the Members listing is
-- PostgREST (services/members.ts, `.from('members').select(...)`) and a
-- predicate there must name a column. An expression index would be unreachable
-- from the only caller, and moving the whole listing to an RPC to gain one
-- would be a far larger change than the feature.
--
-- smallint: the largest value this can hold is 1231.
--
-- THIS REWRITES THE TABLE. `add column ... generated always as ... stored` takes
-- an ACCESS EXCLUSIVE lock for the duration. Accepted rather than discovered:
-- this product's installations are one Station or a small group, and 0031 did
-- the same rewrite twice for the two normalisation columns.
alter table public.members
  add column birth_md smallint
  generated always as (
    (extract(month from birth_date) * 100 + extract(day from birth_date))::smallint
  ) stored;

comment on column public.members.birth_md is
  'The birthday as MMDD (31 December is 1231, 5 January is 105), derived from birth_date and never written by hand. Exists because the Members listing is PostgREST and a birthday window -- which ignores the year -- cannot be expressed there as a predicate on birth_date itself. Null when birth_date is null, which is why a listener nobody asked for a birth date is absent from the birthday filter rather than wrongly included. 29 February is 229 and needs no special case.';

-- PARTIAL, on exactly the rows the screen can reach: a null birth_md can never
-- satisfy the filter, and a soft-deleted listener is already unselectable
-- (members_select_reachable, 0035).
create index members_birth_md_idx on public.members (birth_md)
  where birth_md is not null and deleted_at is null;
