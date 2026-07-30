-- supabase/migrations/0049_promotion_prize_rpcs.sql
--
-- The writes a promotion's prizes take. Each checks its own permission beside
-- the operation rather than inside a shared helper, for the reason 0027's own
-- comment gives: a reader looking for "who may do this" finds it next to the
-- thing being done. Each resolves the Organization and the Station from the
-- promotion row, never from a parameter — a caller must not be able to redirect
-- the permission check at a Station where they happen to hold the code.
--
-- Neither takes a note as a requirement, unlike record_stock_exit and
-- reserve_stock. The link itself names the promotion, which is the explanation
-- an exit or a reservation lacks.

create or replace function public.link_prize_to_promotion(
  p_promotion_id uuid,
  p_prize_id     uuid,
  p_quantity     integer,
  p_note         text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_deleted   timestamptz;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_link      uuid;
begin
  -- FOR UPDATE before anything is read or decided. Two links racing would
  -- otherwise both read the same `available` and each pass a check the other
  -- has already spent — and both would find no live link row and both insert
  -- one, which the partial unique index would then refuse with a constraint
  -- name instead of a sentence. This lock serialises every link and unlink
  -- against one promotion, which is what makes both of those impossible rather
  -- than merely unlikely. Same shape archive_prize uses, for the reason its own
  -- comment gives.
  select organization_id, company_id, cancelled_at, deleted_at
    into v_org, v_company, v_cancelled, v_deleted
  from public.promotions
  where id = p_promotion_id
    for update;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.prizes', v_company) then
    raise log 'link_prize_to_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the number of units must be a positive whole number' using errcode = '22023';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is cancelled and its prizes have already gone back to stock'
      using errcode = '22023';
  end if;

  -- A promotion whose window has CLOSED still accepts links, and that is not an
  -- oversight: the draw happens after entries close (Block 6), so an ended
  -- promotion is exactly when its prizes are most likely to be adjusted. Only
  -- cancellation, above, and archiving, through deleted_at, close the door.

  -- The composite foreign key on promotion_prizes would refuse a prize from
  -- another Station too, but with a constraint name rather than the message a
  -- caller can act on — the same reasoning apply_inventory_movement gives for
  -- its own sufficiency check.
  if not exists (
    select 1 from public.prizes
    where id = p_prize_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  select id into v_link
  from public.promotion_prizes
  where promotion_id = p_promotion_id and prize_id = p_prize_id and deleted_at is null;

  if not found then
    insert into public.promotion_prizes
      (promotion_id, prize_id, organization_id, company_id, created_by)
    values (p_promotion_id, p_prize_id, v_org, v_company, v_actor)
    returning id into v_link;
  end if;

  -- apply_inventory_movement is what refuses an over-link: it reads `available`
  -- under the balance row's own lock and names the figure ("only 3 unit(s) are
  -- in available, and 5 were requested"), which is exactly what the screen
  -- needs to say. Checking it here as well would be a second, weaker copy
  -- racing the first.
  perform public.apply_inventory_movement(
    v_company, p_prize_id, 'PROMOTION_LINK', p_quantity,
    'available', 'linked', v_note, null, v_link);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'link_prize_to_promotion', 'promotion_prizes', v_link, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'prize_id', p_prize_id,
                        'quantity', p_quantity));

  return v_link;
end;
$$;

comment on function public.link_prize_to_promotion(uuid, uuid, integer, text) is
  'Commits N units of a prize to a promotion: creates the link row if there is not a live one, then appends PROMOTION_LINK and moves available -> linked through the ledger''s single writer. Returns the promotion_prizes id, the same one on every call for a pair already linked. Gated on promotions.prizes — its own code, because somebody who may reword a promotion is not thereby somebody who may commit inventory to it. Takes FOR UPDATE on the promotion row first, which serialises every link and unlink against that promotion. Refuses a cancelled or archived promotion, a prize from another Station, a non-positive quantity, and — through apply_inventory_movement, which names the figure — more units than are available. A promotion whose window has closed is deliberately still accepted.';

create or replace function public.unlink_prize_from_promotion(
  p_promotion_id uuid,
  p_prize_id     uuid,
  p_quantity     integer,
  p_note         text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_deleted timestamptz;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_link    uuid;
  v_linked  integer;
  v_drawn   integer;
  v_free    integer;
begin
  -- Same lock, same reason as link_prize_to_promotion: the figure this function
  -- decides on must not move between being read and being spent.
  select organization_id, company_id, deleted_at
    into v_org, v_company, v_deleted
  from public.promotions
  where id = p_promotion_id
    for update;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.prizes', v_company) then
    raise log 'unlink_prize_from_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the number of units must be a positive whole number' using errcode = '22023';
  end if;

  select l.id, coalesce(b.linked, 0), coalesce(b.drawn, 0)
    into v_link, v_linked, v_drawn
  from public.promotion_prizes l
  left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
  where l.promotion_id = p_promotion_id and l.prize_id = p_prize_id and l.deleted_at is null;

  if not found then
    raise exception 'this prize is not linked to this promotion' using errcode = 'P0002';
  end if;

  v_free := v_linked - v_drawn;

  -- D4's floor. The table check (0045) refuses this too, and would refuse it
  -- with a constraint name; the operator deserves both figures — "only 3 of the
  -- 5 unit(s) linked can be returned; 2 have already been drawn" is a sentence
  -- somebody can act on.
  if p_quantity > v_free then
    raise exception
      'only % of the % unit(s) linked can be returned; % have already been drawn',
      v_free, v_linked, v_drawn
      using errcode = '23514';
  end if;

  perform public.apply_inventory_movement(
    v_company, p_prize_id, 'PROMOTION_UNLINK', p_quantity,
    'linked', 'available', v_note, null, v_link);

  -- A link unwound to nothing leaves the Prizes tab rather than sitting there
  -- as a row of zeros; its history is in the ledger, which is where history
  -- belongs. Reachable only when nothing has been drawn — the refusal above
  -- makes linked - p_quantity = 0 impossible while drawn > 0 — so this never
  -- hides a unit that belongs to a winner. The partial unique index (0045) is
  -- what lets the same pair be linked again afterwards.
  if v_linked - p_quantity = 0 then
    update public.promotion_prizes
       set deleted_at = now(), updated_at = now()
     where id = v_link;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'unlink_prize_from_promotion', 'promotion_prizes', v_link, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'prize_id', p_prize_id,
                        'quantity', p_quantity, 'closed', v_linked - p_quantity = 0));
end;
$$;

comment on function public.unlink_prize_from_promotion(uuid, uuid, integer, text) is
  'Returns N committed units to available: appends PROMOTION_UNLINK and moves linked -> available through the ledger''s single writer. Gated on promotions.prizes. Refused below what has been drawn (D4), naming both the free figure and the drawn one — the table check on promotion_prize_balances refuses the same thing structurally, so the floor holds whether or not this check runs first. A link unwound to zero is soft-deleted, which is reachable only when nothing has been drawn; the pair can then be linked again through the partial unique index. Takes FOR UPDATE on the promotion row, so the free figure cannot move between being read and being spent.';

revoke execute on function public.link_prize_to_promotion(uuid, uuid, integer, text)     from public;
revoke execute on function public.unlink_prize_from_promotion(uuid, uuid, integer, text) from public;

grant execute on function public.link_prize_to_promotion(uuid, uuid, integer, text)      to authenticated;
grant execute on function public.unlink_prize_from_promotion(uuid, uuid, integer, text)  to authenticated;
