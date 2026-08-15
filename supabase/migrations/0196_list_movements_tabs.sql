-- supabase/migrations/0196_list_movements_tabs.sql

-- Block 23, Task 4: the read the five prize-record tabs share.
--
-- DUMPED FROM THE LIVE DATABASE, NOT FROM 0096's TEXT. Checked with a
-- throwaway node script (pg_get_functiondef against a freshly `db:reset`
-- database) and diffed byte-for-byte against 0096_list_movements.sql's own
-- body: THEY MATCH EXACTLY. Unlike apply_inventory_movement (0047 appended a
-- parameter after 0027) or inventory_movements_legal_transition (0083 and
-- 0092 both widened it after 0026), list_movements has never drifted from
-- the migration that created it -- this is the first time in this block that
-- "dump the live body first" turned up no surprise, and it is worth saying
-- so rather than leaving the discipline looking like it only ever finds
-- defects.
--
-- WHAT IS NEW BELOW, everything else copied forward verbatim:
--   * p_types, an ARRAY filter beside the existing scalar p_type. The plan's
--     own instruction was to check whether the live function already had a
--     period filter before adding one -- it does (p_from/p_to, unchanged
--     below) -- and the identical check for a movement-type filter finds
--     p_type already there too, singular. Widening it to an array by
--     REPLACING p_type would break every existing caller for no reason this
--     task needs; APPENDING p_types instead is the shape every RPC in this
--     block already prefers (0194's five functions, at length). The two
--     filters AND together when both are given, which no caller today does.
--     p_types is what an Entradas/Saídas/Reservas tab passes to narrow to a
--     GROUP of kinds (BARTER_ENTRY alongside PURCHASE_ENTRY, say) that a
--     single p_type cannot express in one call.
--
--     PLACED LAST IN THE PARAMETER LIST, not after p_type -- caught by
--     running the full suite rather than by reasoning about it first.
--     tests/13_pickup_reads.test.sql calls this function positionally,
--     ten arguments deep, in a dozen places (list_pickups/list_participations'
--     own precedent, unchanged since Block 6d); inserting p_types third
--     shifted every argument after it one slot to the right and turned
--     p_prize_id's null into p_types', which PostgreSQL then refused to
--     resolve at all rather than silently misreading (`function ... does not
--     exist`, twelve failed cases). Moving p_types to the END, after
--     p_limit, is the one position that keeps all ten original slots exactly
--     where every existing positional caller already expects them -- the
--     identical "append, never insert" rule record-params.ts states for
--     PRIZE_TABS and 0194 already followed for every parameter it added to
--     the five doors.
--   * The five columns Task 1 added to the table (invoice_number,
--     unit_amount, total_amount, reserved_for_show_id, reverses_movement_id),
--     projected straight through -- none of them computed, all of them
--     already sitting on the row.
--   * Three values that are NOT stored and must not be (0193's own header:
--     "The original is never updated -- it cannot be, and does not need to
--     be"):
--       - reversed_at / reversal_id, for the ORIGINAL of a reversed pair.
--         inventory_movements_reversal_unique (0193) guarantees at most one
--         row points at a given original with reverses_movement_id set and
--         movement_type <> 'RESERVATION_RELEASE' -- exactly the predicate
--         the lateral below repeats, so the lateral can never find more than
--         one row, and LIMIT 1 is a belt no row can ever need but every
--         reader can trust.
--       - remaining_quantity, for a RESERVATION: its own quantity minus the
--         sum of every RESERVATION_RELEASE pointing at it. The identical
--         formula release_reservation (0194) already computes for its own
--         over-release check, restated here as a read rather than shared
--         code -- 0194's own comment anticipates exactly this: "the same
--         arithmetic the Reservas screen ... will show on each row."
--   * show_name, a plain left join to `shows` for a reservation that names
--     one via reserved_for_show_id -- NOT gated on shows.deleted_at, and
--     that is deliberate rather than an omission (fix round 1, I6: an
--     earlier draft of this comment said "nothing in 0098 gives shows an
--     equivalent rule to honour", which is not why -- shows DOES have a
--     deleted_at column). This is a ledger, and a ledger records what was
--     true when the movement happened: a programme that is archived TODAY
--     was real the day stock was reserved for it, and hiding its name here
--     would make an old, correct reservation unexplainable on the one screen
--     that exists to explain it. promotion_name's owner-only carve-out a few
--     lines below answers a different question (an archived promotion can
--     belong to an Organization this caller is not the owner of, which
--     shows never can -- a show has no cross-Organization visibility
--     question to answer), so it is not a second expression of the same
--     rule left out here; it is a rule that does not apply.
--
-- RETURNS TABLE forces a drop: a function returning a table cannot be
-- CREATE OR REPLACE'd into one returning a wider table, the same rule 0096's
-- own siblings (list_pickups, list_participations) have always been subject
-- to. The DROP below names the live ten-argument signature exactly, with no
-- IF EXISTS: a wrong signature here should fail this migration loudly at
-- db:reset, the same discipline 0194 applied to every DROP in that file.

drop function public.list_movements(
  uuid, public.inventory_movement_type, uuid, uuid,
  timestamptz, timestamptz, timestamptz, uuid, boolean, integer);

create function public.list_movements(
  p_company_id   uuid,
  p_type         public.inventory_movement_type default null,
  p_prize_id     uuid    default null,
  p_promotion_id uuid    default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26,
  -- Block 23, Task 4, appended last -- see the header for why third (after
  -- p_type) broke a dozen positional calls in 13_pickup_reads.test.sql.
  p_types        public.inventory_movement_type[] default null
)
returns table (
  movement_id          uuid,
  created_at           timestamptz,
  movement_type        public.inventory_movement_type,
  quantity             integer,
  from_bucket          public.inventory_bucket,
  to_bucket            public.inventory_bucket,
  prize_id             uuid,
  prize_name           text,
  promotion_id         uuid,
  promotion_name       text,
  promotion_archived   boolean,
  actor_id             uuid,
  actor_name           text,
  note                 text,
  invoice_number       text,
  unit_amount          numeric,
  total_amount         numeric,
  reserved_for_show_id uuid,
  show_name            text,
  reverses_movement_id uuid,
  reversed_at          timestamptz,
  reversal_id          uuid,
  remaining_quantity   integer,
  total_count          integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The one permission the row already needed (inventory_movements_select_
  -- inventory_view, 0029). Unlike list_pickups/list_participations this
  -- function names no second permission: promotions.view buys nothing here,
  -- because promotion_name is returned to inventory.view alone (see header).
  if not public.has_permission('inventory.view', p_company_id) then
    raise log 'list_movements denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: inventory.view required' using errcode = '42501';
  end if;

  return query
  with visible as (
    select m.id,
           m.created_at,
           m.movement_type,
           m.quantity,
           m.from_bucket,
           m.to_bucket,
           m.prize_id,
           pz.name as prize_name,
           pp.promotion_id,
           -- Null for a movement naming no promotion at all (pp is null
           -- through the left join, so pp.promotion_id is null and this
           -- whole expression short-circuits to null). Otherwise: the name,
           -- unless the promotion is archived and this caller is not the
           -- Organization's owner -- 0044's own predicate, through 0044's
           -- own helper, never a second expression of the same rule.
           case
             when pp.promotion_id is null then null
             when pr.deleted_at is null or public.is_owner_of_company(pr.company_id) then pr.name
             else null
           end as promotion_name,
           -- False, never null, when there is no promotion at all: this
           -- column answers "is the null beside it the archival null", and a
           -- movement naming no promotion has no such null to explain.
           (pp.promotion_id is not null and pr.deleted_at is not null) as promotion_archived,
           m.actor_id,
           -- Plain full_name, nullable (0003). A null here does NOT by
           -- itself mean "the clock did it": it can also be a real operator
           -- with no display name on record. actor_id, above, is what tells
           -- the two apart -- null there is the clock (0094); non-null there
           -- with a null name here is a human with none set. A consumer
           -- keys its "(deadline)" label off actor_id, never off this
           -- column.
           pf.full_name as actor_name,
           m.note,
           -- Block 23, Task 4: the five columns 0193 added, projected
           -- straight through -- every one of them already sits on the row,
           -- so none of this needs a join.
           m.invoice_number,
           m.unit_amount,
           m.total_amount,
           m.reserved_for_show_id,
           sh.name as show_name,
           m.reverses_movement_id,
           -- Non-null once something reverses THIS row -- the original of a
           -- reversed pair, most often, but not only that: reverse_movement
           -- (0195) permits reversing a reversal (an ordinary MANUAL_EXIT or
           -- MANUAL_ENTRY, reversible like any other), so a reversal that
           -- was itself later undone reports its own reversed_at here too.
           -- Null on a RESERVATION always -- the predicate below excludes
           -- RESERVATION_RELEASE, and that is the only movement type ever
           -- allowed to point at a RESERVATION. NOT because
           -- inventory_movements_reversal_reference (0193) says so (fix
           -- round 1, I6: an earlier draft of this comment cited it, but that
           -- constraint restricts the REVERSAL's own type -- MANUAL_ENTRY,
           -- MANUAL_EXIT or RESERVATION_RELEASE -- never what it points AT,
           -- so relaxing it would not by itself let a MANUAL_ENTRY/
           -- MANUAL_EXIT point at a RESERVATION). What actually makes it
           -- true is reverse_movement's own runtime refusal (0195:231-232,
           -- "only a stock entry or a stock exit can be reversed here"): it
           -- never writes a MANUAL_ENTRY/MANUAL_EXIT reversal pointing at
           -- anything but an entry or an exit, so a RESERVATION is never a
           -- reversal's target in practice. A future author relaxing that
           -- door check on the strength of the WRONG citation above would
           -- have believed the constraint still protected this; it does not.
           rv.reversed_at,
           rv.reversal_id,
           -- A RESERVATION's own quantity minus every RESERVATION_RELEASE
           -- pointing at it. Null for every other movement type -- there is
           -- no "remaining" to speak of on an entry, an exit or a draw, and
           -- a stored zero would read as a fully-released reservation
           -- instead of a question that does not apply.
           case
             when m.movement_type = 'RESERVATION' then
               -- sum(integer) is bigint, and integer - bigint is bigint --
               -- cast back to integer, which remaining_quantity's column
               -- type in RETURNS TABLE actually is, to match it exactly.
               m.quantity - coalesce((
                 select sum(rel.quantity)
                   from public.inventory_movements rel
                  where rel.reverses_movement_id = m.id
                    and rel.movement_type = 'RESERVATION_RELEASE'
               ), 0)::integer
             else null
           end as remaining_quantity
      from public.inventory_movements m
      join public.prizes pz
        on pz.id = m.prize_id
      left join public.promotion_prizes pp
        on pp.id = m.promotion_prize_id and pp.company_id = m.company_id
      left join public.promotions pr
        on pr.id = pp.promotion_id and pr.company_id = m.company_id
      left join public.profiles pf
        on pf.id = m.actor_id
      -- Block 23, Task 4.
      left join public.shows sh
        on sh.id = m.reserved_for_show_id and sh.company_id = m.company_id
      left join lateral (
        select r.created_at as reversed_at, r.id as reversal_id
          from public.inventory_movements r
         where r.reverses_movement_id = m.id
           and r.movement_type <> 'RESERVATION_RELEASE'
         limit 1
      ) rv on true
     where m.company_id = p_company_id
       and (p_type is null         or m.movement_type = p_type)
       -- Block 23, Task 4: a second, plural way to narrow by kind. ANDed
       -- with p_type above rather than replacing it -- no caller today
       -- passes both, and a caller that did would get the intersection,
       -- which is the honest reading of two filters given together.
       --
       -- DECIDED, not left ambiguous (fix round 1, minor): NULL means "no
       -- filter" (the sentinel every other parameter here uses), but an
       -- EMPTY array is a different value on purpose, and `= any('{}')` is
       -- always false -- so p_types => ARRAY[]::inventory_movement_type[]
       -- matches NOTHING, not "every kind". A caller computing this array
       -- dynamically (Tasks 5-8, one constant group of kinds per tab) must
       -- pass null, never an empty array, to mean "no filter".
       and (p_types is null        or m.movement_type = any(p_types))
       and (p_prize_id is null     or m.prize_id = p_prize_id)
       and (p_promotion_id is null or pp.promotion_id = p_promotion_id)
       and (p_from is null         or m.created_at >= p_from)
       and (p_to is null           or m.created_at <= p_to)
  )
  select f.id,
         f.created_at,
         f.movement_type,
         f.quantity,
         f.from_bucket,
         f.to_bucket,
         f.prize_id,
         f.prize_name,
         f.promotion_id,
         f.promotion_name,
         f.promotion_archived,
         f.actor_id,
         f.actor_name,
         f.note,
         f.invoice_number,
         f.unit_amount,
         f.total_amount,
         f.reserved_for_show_id,
         f.show_name,
         f.reverses_movement_id,
         f.reversed_at,
         f.reversal_id,
         f.remaining_quantity,
         -- The total of the FILTERED set, computed from the SAME CTE the
         -- rows come from, so a page and its count cannot narrow differently
         -- (0090's rule, restated here).
         (select count(*) from visible)::integer as total_count
    from visible f
   -- No cursor at all (p_cursor_id null) means the first page. Otherwise a
   -- plain tuple comparison: created_at is NOT NULL on every row (0026), so
   -- there is no terminal null region to reach separately the way
   -- list_pickups' deadline_at needs -- the same shape list_participations'
   -- participated_at cursor already uses.
   where p_cursor_at is null
      or p_cursor_id is null
      or (case when p_walking_back
               then (f.created_at, f.id) > (p_cursor_at, p_cursor_id)
               else (f.created_at, f.id) < (p_cursor_at, p_cursor_id)
          end)
   -- Newest first, tie-broken by id. Walking back reads the opposite of
   -- display order and the caller reverses the small batch, exactly as
   -- list_participations' own keyset does it.
   order by
     case when p_walking_back then f.created_at end asc,
     case when p_walking_back then f.id end asc,
     case when not p_walking_back then f.created_at end desc,
     case when not p_walking_back then f.id end desc
   limit p_limit;
end;
$$;

comment on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer, public.inventory_movement_type[]) is
  'One keyset page of a Station''s whole inventory ledger, newest first (created_at desc, movement_id desc -- created_at is NOT NULL, so unlike list_pickups there is no terminal null region to reach). Gated on inventory.view alone, the same single permission inventory_movements_select_inventory_view (0029) already required for the row. promotion_name/promotion_archived and actor_id/actor_name keep 0096''s original reasoning unchanged -- see that migration''s header for the archived-promotion and clock-vs-nameless-human distinctions, both still load-bearing. Block 23, Task 4 widened this function, dumped from the live database and verified to match 0096''s text exactly before any of the below was added: p_types (an array, ANDed with the pre-existing scalar p_type rather than replacing it) narrows to a GROUP of kinds in one call; invoice_number/unit_amount/total_amount/reserved_for_show_id/reverses_movement_id (0193) are projected straight through, none of them computed; show_name is a plain left join to shows, with no archival-hiding rule of promotion_name''s kind because shows carries none; reversed_at/reversal_id come from a left join lateral onto the row whose reverses_movement_id names this one (at most one such row can exist, by inventory_movements_reversal_unique, 0193); remaining_quantity is a RESERVATION''s own quantity minus the sum of every RESERVATION_RELEASE pointing at it, null for every other movement type. None of the last three is stored, and none of them should be (0193''s header) -- reverse_movement (0195) never updates the original it undoes, so "was this reversed" and "how much of this reservation is left" are questions this read answers by looking at what points at a row, not by a flag or a running total on the row itself.';

revoke execute on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer, public.inventory_movement_type[]) from public;
grant execute on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer, public.inventory_movement_type[]) to authenticated;
