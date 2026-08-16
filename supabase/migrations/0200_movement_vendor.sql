-- supabase/migrations/0200_movement_vendor.sql

-- Block 24, item 8: which supplier an entry came from.
--
-- ON THE ENTRY, NOT ON THE PRIZE (design D7). The same prize is bought from
-- different suppliers in different months, and the invoice number it sits beside
-- has been per entry since Block 23. A column on `prizes` would answer "who
-- supplied this" with one name for a shelf that several suppliers filled.
--
-- ---------------------------------------------------------------------------
-- EVERY FUNCTION BELOW IS DROPPED AND RECREATED FROM ITS LIVE DEFINITION, read
-- with `pg_get_functiondef` against a freshly `db:reset` database before this
-- file was written. Not from the migration that first created it:
--
--   * `apply_inventory_movement` lives in 0194, not 0027 (0047 and 0194 have
--     each replaced it);
--   * `record_stock_entry` lives in 0194, not 0027;
--   * `list_movements` lives in 0196, not 0096.
--
-- Rebuilding one from its original migration silently reverts every fix made
-- since, which is the defect this repository has shipped three times.
--
-- DROPPED rather than `create or replace`d, on 0194's own finding: CREATE OR
-- REPLACE matches an existing function by its FULL parameter type list, so
-- appending a parameter — even a defaulted one — produces a second, coexisting
-- overload and every old-arity call becomes ambiguous with 42725 at call time.
-- `list_movements` additionally changes its RETURNS TABLE, which cannot be
-- replaced at all.
-- ---------------------------------------------------------------------------

alter table public.inventory_movements
  add column vendor_id uuid,

  -- The composite form, so the pointer cannot land in another Station's
  -- supplier list. A plain `references public.vendors (id)` would prove the
  -- vendor exists and nothing about whose it is — the argument 0193 makes at
  -- length for its own reversal pointer, and 0025 before it.
  add constraint inventory_movements_vendor_company_fk
    foreign key (vendor_id, company_id)
    references public.vendors (id, company_id),

  -- The column is permitted on exactly the movement kinds it means something
  -- for, and null everywhere else — the shape 0193 gave invoice_number and
  -- reserved_for_show_id, and 0045 gave promotion_prize_id before them. The
  -- entry list here is deliberately THE SAME ONE
  -- inventory_movements_invoice_reference already names: a supplier and an
  -- invoice are two halves of one fact, and two lists that could drift apart is
  -- how they come to disagree about which movement may carry paperwork.
  add constraint inventory_movements_vendor_reference check (
    (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY'))
    or vendor_id is null
  );

comment on column public.inventory_movements.vendor_id is
  'The supplier this stock came in from. Entries only, by inventory_movements_vendor_reference — the same movement kinds inventory_movements_invoice_reference names, because a supplier and an invoice are two halves of one fact. Never updated: the ledger is immutable, so a mistyped vendor is corrected by reversing the entry and recording it again.';

-- "Everything we bought from this supplier" is a scan of one Station's entries
-- today. Partial, because the overwhelming majority of movements — draws,
-- deliveries, reservations — carry no vendor at all.
create index inventory_movements_vendor_idx
  on public.inventory_movements (company_id, vendor_id)
  where vendor_id is not null;

-- ---------------------------------------------------------------------------
-- apply_inventory_movement: the single writer, widened by one column.
-- ---------------------------------------------------------------------------

drop function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text,
  uuid, text, numeric, numeric, uuid, uuid);

-- NO `security definer`, and that is copied forward deliberately rather than
-- overlooked: this function is SECURITY INVOKER so that it runs as whichever
-- door called it, and every door is itself SECURITY DEFINER. Making it a
-- definer would let anything holding EXECUTE write the ledger directly.
create function public.apply_inventory_movement(
  p_company_id uuid,
  p_prize_id uuid,
  p_type public.inventory_movement_type,
  p_quantity integer,
  p_from public.inventory_bucket,
  p_to public.inventory_bucket,
  p_note text,
  p_idempotency_key text,
  p_promotion_prize_id uuid default null,
  p_invoice_number text default null,
  p_unit_amount numeric default null,
  p_total_amount numeric default null,
  p_show_id uuid default null,
  p_reverses uuid default null,
  -- Block 24. Appended last, so every existing positional call is unchanged.
  p_vendor_id uuid default null
)
returns uuid
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_current  integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be a positive whole number' using errcode = '22023';
  end if;

  -- The prize must be live and belong to this Station. The composite foreign key
  -- proves the Station; it cannot see deleted_at, because it references a
  -- non-partial constraint — a foreign key cannot reference a partial index.
  -- FOR SHARE holds this row against archive_prize's FOR UPDATE on the same
  -- prize. archive_prize's own guard reads inventory_balances, which does not
  -- exist yet for a prize's first-ever movement — locking a row that is not
  -- there locks nothing — so without a lock on the prize itself, a movement
  -- could read the prize as live here, archive_prize could see zero stock and
  -- archive it, and this call could still go on to write stock onto a prize
  -- that is now archived. This lock, plus archive_prize's, closes that
  -- regardless of whether a balance row exists.
  select organization_id into v_org
  from public.prizes
  where id = p_prize_id and company_id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this is the prize's first movement, then lock it.
  -- Shared with adjust_stock (0030) so there is exactly one INSERT statement
  -- against this table anywhere in the schema — see
  -- ensure_inventory_balance_row's own comment.
  perform public.ensure_inventory_balance_row(p_company_id, p_prize_id, v_org);

  perform 1 from public.inventory_balances
   where company_id = p_company_id and prize_id = p_prize_id
     for update;

  -- Taken here — immediately after the FOR UPDATE on inventory_balances and
  -- before the movement is appended — rather than beside the arithmetic below,
  -- so the lock order is the same for every caller; a replay that returns early
  -- will have bootstrapped an all-zero row and written nothing to it, which is
  -- exactly what ensure_inventory_balance_row already does on the same path.
  if p_promotion_prize_id is not null then
    perform public.ensure_promotion_prize_balance_row(
      p_promotion_prize_id, p_prize_id, p_company_id, v_org);

    perform 1 from public.promotion_prize_balances
     where promotion_prize_id = p_promotion_prize_id
       for update;
  end if;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  --
  -- promotion_prize_id travels on the movement itself, so the ledger — not only
  -- the projection — records which link the units moved under, and
  -- reconcile_inventory (0048) can rebuild one from the other.
  -- inventory_movements_promotion_reference (0045, widened in 0077) is what
  -- refuses the two ways that can be wrong: a link or draw movement naming no
  -- promotion, and any other movement type naming one.
  --
  -- Block 23, Task 2: the same reasoning now covers invoice_number,
  -- unit_amount, total_amount (entries only), reserved_for_show_id
  -- (reservations only) and reverses_movement_id (reversals and releases
  -- only) — inventory_movements_invoice_reference, _show_reference and
  -- _reversal_reference (0193) are what refuse a movement writing one of these
  -- outside the kind it belongs to.
  --
  -- Block 24: and vendor_id, entries only, by
  -- inventory_movements_vendor_reference (0200).
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id, promotion_prize_id,
     invoice_number, unit_amount, total_amount, reserved_for_show_id, reverses_movement_id,
     vendor_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor,
     p_promotion_prize_id,
     nullif(trim(coalesce(p_invoice_number, '')), ''), p_unit_amount, p_total_amount,
     p_show_id, p_reverses,
     p_vendor_id)
  on conflict (company_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- A replay. Return the original movement and touch nothing else: the balance
    -- already reflects it.
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if v_id is null then
      raise exception 'movement could not be recorded' using errcode = 'XX000';
    end if;
    return v_id;
  end if;

  -- Source sufficiency. The CHECK constraints would also refuse this, but
  -- they would refuse it with a constraint name; the caller deserves the number.
  if p_from is not null then
    execute format('select %I from public.inventory_balances where company_id = $1 and prize_id = $2', p_from)
      into v_current using p_company_id, p_prize_id;

    -- The bootstrap insert above guarantees the row exists, so this is never
    -- actually NULL today — but that guarantee is implicit, and NULL < integer
    -- is NULL, not true, which would let the sufficiency check below fall
    -- through silently and the subsequent UPDATE touch zero rows: a movement
    -- recorded in the ledger that never reached the projection.
    v_current := coalesce(v_current, 0);

    if v_current < p_quantity then
      raise exception 'only % unit(s) are in %, and % were requested', v_current, p_from, p_quantity
        using errcode = '23514';
    end if;

    execute format(
      'update public.inventory_balances set %I = %I - $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_from, p_from
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  if p_to is not null then
    execute format(
      'update public.inventory_balances set %I = %I + $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_to, p_to
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  -- This reads movement_type, which the bucket arithmetic above deliberately
  -- does not. The reasoning, and the tripwire for an unknown type, now live in
  -- project_promotion_prize_movement (0077).
  if p_promotion_prize_id is not null then
    perform public.project_promotion_prize_movement(p_promotion_prize_id, p_type, p_quantity);
  end if;

  -- The detail gains promotion_prize_id as a final key rather than omitting it
  -- when there is none: it is null on every movement that names no promotion,
  -- so every row Block 2 already writes keeps the same shape and the audit log
  -- stays readable by one query instead of two.
  --
  -- vendor_id is NOT added here, and neither were Block 23's five: this detail
  -- is not a mirror of the row. It carries what the movement DID — which prize,
  -- which direction, how many — and the row itself carries the paperwork, one
  -- join away for anybody who wants it.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to,
                        'promotion_prize_id', p_promotion_prize_id));

  return v_id;
end;
$$;

-- THE MOST IMPORTANT LINE IN THIS FILE. A newly created function carries the
-- default EXECUTE grant to PUBLIC, so without this every role in the database
-- could call the ledger's single writer directly and bypass every permission
-- check the movement doors make. `drop` + `create` throws the old function's
-- ACL away with it, so this has to be restated on every recreation — 0194 says
-- the same beside its own copy, and 02_permissions.test.sql asserts it, which
-- is how its absence here was caught rather than shipped.
--
-- No grant to `authenticated` follows: this function is SECURITY INVOKER and is
-- reachable only from inside a SECURITY DEFINER body, where it runs with that
-- body's privileges.
revoke execute on function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text,
  uuid, text, numeric, numeric, uuid, uuid, uuid
) from public;

comment on function public.apply_inventory_movement is
  'The single writer of inventory_movements and the single maintainer of the inventory_balances projection. SECURITY INVOKER on purpose — it runs as whichever SECURITY DEFINER door called it — and EXECUTE granted to nobody. Idempotent on (company_id, idempotency_key). Block 24 appended p_vendor_id after Block 23''s five, threaded straight into the INSERT; inventory_movements_vendor_reference (0200), not this function, refuses it on the movement kinds it does not belong to. Dropped and recreated rather than replaced, exactly as 0047 and 0194 were: CREATE OR REPLACE cannot change an argument list without leaving the prior arity as a second, ambiguous overload.';

-- ---------------------------------------------------------------------------
-- record_stock_entry: the door an operator reaches.
-- ---------------------------------------------------------------------------

drop function public.record_stock_entry(
  uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric);

create function public.record_stock_entry(
  p_company_id uuid,
  p_prize_id uuid,
  p_type public.inventory_movement_type,
  p_quantity integer,
  p_note text default null,
  p_idempotency_key text default null,
  p_invoice_number text default null,
  p_unit_amount numeric default null,
  p_total_amount numeric default null,
  -- Block 24. Optional, and it must be: a barter from a listener has no
  -- supplier, and every entry recorded before this migration has none either.
  p_vendor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Existence only: apply_inventory_movement re-resolves the Organization from
  -- the prize itself, which also proves the prize belongs to THIS Station —
  -- the stricter fact. Resolving it again here would just be a second, weaker
  -- copy of that same proof.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.entry', p_company_id) then
    raise log 'record_stock_entry denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.entry required' using errcode = '42501';
  end if;

  if p_type not in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY') then
    raise exception 'record_stock_entry does not accept movement type %', p_type
      using errcode = '22023';
  end if;

  -- BLOCK 24. The vendor is checked HERE rather than left to the foreign key,
  -- and the two things it checks are different failures with one message.
  --
  -- The composite key would catch a vendor from another Station, but as a 23503
  -- naming a constraint — which maps to InternalError and reaches the operator
  -- as "Could not save". And it would NOT catch an ARCHIVED vendor at all: the
  -- key references vendors_id_company_unique, a non-partial constraint, because
  -- a foreign key cannot reference a partial index (0198 says so where the index
  -- is declared). So an archived supplier would be accepted silently by the
  -- database and quietly reappear on a new purchase.
  --
  -- Read from inside this SECURITY DEFINER body, where 0198's select policy does
  -- not apply — which is what lets `deleted_at is null` here mean the vendor is
  -- archived rather than merely unreadable by this caller.
  if p_vendor_id is not null then
    perform 1 from public.vendors
     where id = p_vendor_id and company_id = p_company_id and deleted_at is null;

    if not found then
      raise exception 'vendor not found in this station: %', p_vendor_id
        using errcode = '22023';
    end if;
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, p_type, p_quantity, null, 'available', p_note, p_idempotency_key,
    p_invoice_number => p_invoice_number,
    p_unit_amount    => p_unit_amount,
    p_total_amount   => p_total_amount,
    p_vendor_id      => p_vendor_id
  );
end;
$$;

comment on function public.record_stock_entry is
  'Adds available stock. Gated on inventory.entry. Restricted to INITIAL_ENTRY, PURCHASE_ENTRY, MANUAL_ENTRY and BARTER_ENTRY — any other type is refused with 22023. Carries the invoice number, unit price and total (Block 23) and the supplier (Block 24), all optional. A vendor from another Station or an archived one is refused with 22023 as a sentence: the foreign key would give the first a constraint name and would miss the second entirely, because it references a non-partial unique constraint that cannot see deleted_at.';

revoke execute on function public.record_stock_entry(
  uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric, uuid
) from public;
grant execute on function public.record_stock_entry(
  uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- list_movements: the single read, gaining the supplier's name.
-- ---------------------------------------------------------------------------

drop function public.list_movements(
  uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz,
  timestamptz, uuid, boolean, integer, public.inventory_movement_type[]);

create function public.list_movements(
  p_company_id uuid,
  p_type public.inventory_movement_type default null,
  p_prize_id uuid default null,
  p_promotion_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_walking_back boolean default false,
  p_limit integer default 26,
  p_types public.inventory_movement_type[] default null
)
returns table (
  movement_id uuid,
  created_at timestamptz,
  movement_type public.inventory_movement_type,
  quantity integer,
  from_bucket public.inventory_bucket,
  to_bucket public.inventory_bucket,
  prize_id uuid,
  prize_name text,
  promotion_id uuid,
  promotion_name text,
  promotion_archived boolean,
  actor_id uuid,
  actor_name text,
  note text,
  invoice_number text,
  unit_amount numeric,
  total_amount numeric,
  reserved_for_show_id uuid,
  show_name text,
  reverses_movement_id uuid,
  reversed_at timestamptz,
  reversal_id uuid,
  remaining_quantity integer,
  -- Block 24, appended before total_count so the count stays last, which is
  -- where every other listing function in this schema keeps it.
  vendor_id uuid,
  vendor_name text,
  total_count integer
)
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
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
           end as remaining_quantity,
           -- Block 24. The id as well as the name, because a screen that wants
           -- to link to the supplier's record needs the id and re-deriving it
           -- from a name is how two vendors called "Camisetas do Sul" become
           -- one link.
           m.vendor_id,
           vd.name as vendor_name
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
      -- Block 24. LEFT, and with no `deleted_at is null` filter: an entry from a
      -- supplier the Station has since stopped using must go on naming them.
      -- archive_vendor is deliberately never refused over the entries that point
      -- at it (0199), so filtering here would turn every one of those rows into
      -- a purchase from nobody.
      left join public.vendors vd
        on vd.id = m.vendor_id and vd.company_id = m.company_id
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
         f.vendor_id,
         f.vendor_name,
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

comment on function public.list_movements is
  'One keyset page of a Station''s stock ledger, with the prize, the promotion link, the actor, Block 23''s invoice and reversal columns, and Block 24''s supplier. SECURITY DEFINER, gated on inventory.view alone. The vendor join is unfiltered by deleted_at on purpose: archiving a supplier never rewrites the entries that named them.';

revoke execute on function public.list_movements(
  uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz,
  timestamptz, uuid, boolean, integer, public.inventory_movement_type[]
) from public;
grant execute on function public.list_movements(
  uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz,
  timestamptz, uuid, boolean, integer, public.inventory_movement_type[]
) to authenticated;
