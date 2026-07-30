-- supabase/migrations/0048_reconcile_promotion_prizes.sql
--
-- reconcile_inventory gains the second projection. Dropped and recreated
-- because its OUT parameter list changes, which create or replace cannot do —
-- the same constraint 0047 hit, with none of that one's danger: this function
-- has no callers inside the database, only PostgREST and the isolation suite,
-- and both resolve it by name.
--
-- It still reports; it does not repair. No INSERT, UPDATE or DELETE appears in
-- it, and none should ever be added: a projection that silently self-heals
-- turns a bug in a movement RPC into a number that is briefly wrong and then
-- quietly right, which is the hardest kind to find.
--
-- Every reference below is table- or alias-qualified, and neither this
-- migration applying nor this function being created proves that it needed to
-- be. Under `language plpgsql`, check_function_bodies runs only the plpgsql
-- syntax validator, which never resolves an identifier against the catalog: an
-- ambiguity between an OUT parameter and a column surfaces on the first
-- EXECUTION of the offending statement, not at create time. A clean
-- `supabase db reset` says nothing about it. 02_permissions.test.sql actually
-- calling this function is what does.
--
-- And ambiguity is only the loud half. plpgsql.variable_conflict = error fires
-- where a name matches BOTH a variable and a visible column. A name matching
-- ONLY an OUT parameter — `stored` or `computed` in a select list with no such
-- column in scope — is substituted with the variable's value silently, no
-- diagnostic of any kind, and a query that returns quiet nonsense is what
-- qualifying every reference actually buys protection against. 0028 was
-- already written this way for the same reason.
drop function public.reconcile_inventory(uuid);

create function public.reconcile_inventory(p_company_id uuid)
returns table (
  prize_id           uuid,
  prize_name         text,
  promotion_prize_id uuid,
  promotion_name     text,
  bucket             text,
  stored             integer,
  computed           integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.has_permission('inventory.view', p_company_id) then
    raise log 'reconcile_inventory denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.view required' using errcode = '42501';
  end if;

  return query
    -- Each movement carries from_bucket/to_bucket, never a signed quantity —
    -- quantity is always positive (0026's check constraint), and direction
    -- lives entirely in which bucket column is which. So the computed value
    -- of a bucket b is the sum of quantities where it was the destination
    -- minus the sum where it was the source; a NULL bucket means "outside the
    -- Station" and contributes to nothing. Reading movement_type here instead
    -- would make this function's correctness depend on every type ever being
    -- kept in sync with its own bucket pair, which is exactly the class of
    -- defect inventory_movements_legal_transition (0026) already makes
    -- unrepresentable at insert time. A bucket a prize's movements never
    -- mention simply has no row in this CTE — folded to 0 by the coalesce
    -- below, which is the correct computed value for it.
    --
    -- Carried from 0028 unchanged, because the per-promotion half below reads
    -- movement_type and says it is doing the opposite of "the half above" —
    -- a contrast the next reader can only check against the argument itself.
    with movement_totals as (
      select m.prize_id, m.to_bucket as bucket, m.quantity as signed_qty
      from public.inventory_movements m
      where m.company_id = p_company_id and m.to_bucket is not null
      union all
      select m.prize_id, m.from_bucket as bucket, -m.quantity as signed_qty
      from public.inventory_movements m
      where m.company_id = p_company_id and m.from_bucket is not null
    ),
    -- 0028's `computed`, renamed only to keep it distinct from the OUT
    -- parameter of the same name now that a second half of this query also
    -- has one.
    computed_buckets as (
      select t.prize_id, t.bucket, sum(t.signed_qty)::integer as computed
      from movement_totals t
      group by t.prize_id, t.bucket
    ),
    -- Every stored bucket, for every balance row this Station has, unpivoted
    -- to the same (prize_id, bucket) shape as computed_buckets — all seven
    -- buckets, the five physical ones plus delivered and written_off, which
    -- are cumulative counters outside the physical total and never zeroed by a
    -- later movement. A balance row with zero movements behind it still
    -- appears here, which is what lets a hand-corrupted row surface even when
    -- the ledger says nothing should be there at all.
    --
    -- 0028's `stored`, renamed for the same reason computed_buckets was.
    stored_buckets as (
      select b.prize_id, v.bucket, v.stored
      from public.inventory_balances b,
      lateral (values
        ('available'::public.inventory_bucket,      b.available),
        ('reserved'::public.inventory_bucket,        b.reserved),
        ('linked'::public.inventory_bucket,          b.linked),
        ('awaiting_pickup'::public.inventory_bucket, b.awaiting_pickup),
        ('pending_return'::public.inventory_bucket,  b.pending_return),
        ('delivered'::public.inventory_bucket,       b.delivered),
        ('written_off'::public.inventory_bucket,      b.written_off)
      ) as v(bucket, stored)
      where b.company_id = p_company_id
    ),

    -- FULL OUTER JOIN, keyed on (prize_id, bucket): a plain join would drop
    -- exactly the two divergences that matter most — a prize with movements and
    -- no balance row (present only in computed_buckets), and a balance row with
    -- no movements (present only in stored_buckets) — instead of surfacing
    -- them. The coalesce()s are what turn "absent from this side" into the
    -- correct zero rather than a NULL.
    --
    -- That is also why the filter is coalesce(...) <> coalesce(...) and not a
    -- bare <>. A NULL on either side makes a bare <> evaluate to NULL, which
    -- WHERE treats as not-true, so the row would be dropped — silently losing
    -- precisely the one-sided case the FULL OUTER JOIN was chosen to catch.
    -- Carried from 0028, and load-bearing twice over now: per_promotion below
    -- repeats both patterns and points back here for the reason.
    per_prize as (
      select
        coalesce(s.prize_id, c.prize_id)   as prize_id,
        coalesce(s.bucket, c.bucket)::text as bucket,
        coalesce(s.stored, 0)              as stored,
        coalesce(c.computed, 0)            as computed
      from stored_buckets s
      full outer join computed_buckets c
        on c.prize_id = s.prize_id and c.bucket = s.bucket
      where coalesce(s.stored, 0) <> coalesce(c.computed, 0)
    ),

    -- The per-promotion half reads movement_type, which the half above
    -- deliberately does not. It has to: `linked` on promotion_prize_balances is
    -- not the `linked` bucket. It counts units committed to the promotion and
    -- is NOT decremented when one is drawn — drawn is its own counter, and
    -- Resto is linked - drawn. The two halves of this one function now read the
    -- ledger differently, and each is right for what it measures; said out loud
    -- rather than left for the next reader to reconcile on their own.
    promotion_computed as (
      select
        m.promotion_prize_id,
        'linked'::text as bucket,
        sum(case when m.movement_type = 'PROMOTION_LINK'   then  m.quantity
                 when m.movement_type = 'PROMOTION_UNLINK' then -m.quantity
                 else 0 end)::integer as computed
      from public.inventory_movements m
      where m.company_id = p_company_id and m.promotion_prize_id is not null
      group by m.promotion_prize_id
      union all
      -- DRAW and DRAW_CANCEL cannot carry a promotion_prize_id until Block 6
      -- widens the ledger check (0045), so this arm computes 0 for every row
      -- today. It is here rather than omitted because `drawn` IS stored, and a
      -- stored figure nothing recomputes is a figure that can be wrong forever:
      -- a hand-written drawn surfaces as stored = N against computed = 0, which
      -- is the truth — the ledger has no record of it.
      --
      -- When Block 6 starts writing those movements this arm begins returning
      -- real figures, but it may well need widening first and Block 6's
      -- implementer should check this rather than trust it. It handles DRAW and
      -- DRAW_CANCEL only; DELIVERY, RETURN_PENDING and RETURN_TO_STOCK all fall
      -- to the `else 0` today, and whether a delivered or returned unit should
      -- leave `drawn` is an open question nobody has settled. It is not a free
      -- choice either: promotion_prize_balances' drawn <= linked check (0045)
      -- constrains what the answer is allowed to be.
      select
        m.promotion_prize_id,
        'drawn'::text,
        sum(case when m.movement_type = 'DRAW'        then  m.quantity
                 when m.movement_type = 'DRAW_CANCEL' then -m.quantity
                 else 0 end)::integer
      from public.inventory_movements m
      where m.company_id = p_company_id and m.promotion_prize_id is not null
      group by m.promotion_prize_id
    ),

    promotion_stored as (
      select b.promotion_prize_id, v.bucket, v.stored
      from public.promotion_prize_balances b,
      lateral (values
        ('linked'::text, b.linked),
        ('drawn'::text,  b.drawn)
      ) as v(bucket, stored)
      where b.company_id = p_company_id
    ),

    -- FULL OUTER JOIN for the same reason the half above uses one: a link with
    -- movements and no balance row, and a balance row with no movements behind
    -- it, are exactly the two divergences an inner join would drop.
    per_promotion as (
      select
        coalesce(ps.promotion_prize_id, pc.promotion_prize_id) as promotion_prize_id,
        coalesce(ps.bucket, pc.bucket)                         as bucket,
        coalesce(ps.stored, 0)                                 as stored,
        coalesce(pc.computed, 0)                               as computed
      from promotion_stored ps
      full outer join promotion_computed pc
        on pc.promotion_prize_id = ps.promotion_prize_id and pc.bucket = ps.bucket
      where coalesce(ps.stored, 0) <> coalesce(pc.computed, 0)
    )

    select pp.prize_id, pz.name, null::uuid, null::text, pp.bucket, pp.stored, pp.computed
    from per_prize pp
    join public.prizes pz on pz.id = pp.prize_id
    union all
    -- The link is joined without its deleted_at filter on purpose: a link that
    -- was unwound to nothing still has ledger rows behind it, and a divergence
    -- on a soft-deleted link is exactly as much of a problem as one on a live
    -- link. Filtering it out here would make unlinking a way to hide a broken
    -- figure.
    select l.prize_id, pz.name, x.promotion_prize_id, pr.name, x.bucket, x.stored, x.computed
    from per_promotion x
    join public.promotion_prizes l on l.id = x.promotion_prize_id
    join public.prizes pz          on pz.id = l.prize_id
    join public.promotions pr      on pr.id = l.promotion_id
    -- Position 5 is the bucket as TEXT, so this sorts alphabetically where 0028
    -- sorted by the enum's own declaration order. A deliberate simplification
    -- with a cost, not something the types forced. The premise is real —
    -- `drawn` is not a value of public.inventory_bucket, it is a counter on
    -- promotion_prize_balances, so the union cannot be ordered by the enum
    -- directly — but wrapping the whole union in a subselect and ordering by a
    -- `case` rank would have preserved 0028's order, and that was simply not
    -- done. The cost, named rather than left to be discovered: a prize
    -- diverging in several buckets at once now lists them alphabetically
    -- instead of in the order the balances screen puts them in. Accepted
    -- because a reconciliation result is read a row at a time, not scanned as
    -- a column — revisit it the moment that stops being true.
    --
    -- Ordinals rather than names because a UNION takes its output names from
    -- the first branch, where columns 3 and 4 are bare nulls.
    order by 2, 4 nulls first, 5;
end;
$$;

comment on function public.reconcile_inventory(uuid) is
  'Recomputes both projections for a Station from inventory_movements alone and returns only the rows where the stored figure differs. Per-prize rows carry a null promotion_prize_id and promotion_name, and are computed from the bucket pair — computed(b) = sum(quantity where to_bucket = b) - sum(quantity where from_bucket = b) — so a movement type introduced by a later Block needs no change here. Per-promotion rows name the link and the promotion, and are computed from movement_type instead, because linked on that projection counts units committed to the promotion and is NOT decremented by a draw. The drawn arm computes 0 for every row until Block 6 starts writing DRAW movements that carry a promotion reference; it is present today so that a hand-written drawn surfaces as stored=N against computed=0. It reports; it does not repair — no INSERT, UPDATE or DELETE appears in this function. Both halves use a FULL OUTER JOIN so a key present on only one side is not silently dropped. Soft-deleted links are included: unlinking must not become a way to hide a divergence. Gated on inventory.view, resolved from p_company_id — never from a caller-supplied Organization id.';

revoke execute on function public.reconcile_inventory(uuid) from public;
grant execute on function public.reconcile_inventory(uuid) to authenticated;
