-- supabase/migrations/0028_reconcile_inventory.sql

-- inventory_balances (0026) is a projection: it exists only because summing
-- the ledger on every render would be slow, and it is written only inside
-- apply_inventory_movement's transaction. This function is how that claim
-- stays honest — it recomputes every balance for a Station straight from
-- inventory_movements and returns the rows where the stored figure and the
-- computed figure disagree.
--
-- It reports; it does not repair. A projection that silently self-heals turns
-- a bug in a movement RPC into a number that is briefly wrong and then
-- quietly right, which is the hardest kind to find. If this returns rows,
-- something is broken and a person needs to know. Accordingly this function
-- contains no INSERT, UPDATE or DELETE, and none should ever be added to it.
create or replace function public.reconcile_inventory(p_company_id uuid)
returns table (
  prize_id   uuid,
  prize_name text,
  bucket     text,
  stored     integer,
  computed   integer
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
    with movement_totals as (
      select m.prize_id, m.to_bucket as bucket, m.quantity as signed_qty
      from public.inventory_movements m
      where m.company_id = p_company_id and m.to_bucket is not null
      union all
      select m.prize_id, m.from_bucket as bucket, -m.quantity as signed_qty
      from public.inventory_movements m
      where m.company_id = p_company_id and m.from_bucket is not null
    ),
    computed as (
      select t.prize_id, t.bucket, sum(t.signed_qty)::integer as computed
      from movement_totals t
      group by t.prize_id, t.bucket
    ),
    -- Every stored bucket, for every balance row this Station has, unpivoted
    -- to the same (prize_id, bucket) shape as computed — all seven buckets,
    -- the five physical ones plus delivered and written_off, which are
    -- cumulative counters outside the physical total and never zeroed by a
    -- later movement. A balance row with zero movements behind it still
    -- appears here, which is what lets a hand-corrupted row surface even when
    -- the ledger says nothing should be there at all.
    stored as (
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
    )
    -- FULL OUTER JOIN, keyed on (prize_id, bucket): a plain join would drop
    -- exactly the two divergences that matter most — a prize with movements
    -- and no balance row (present only in computed), and a balance row with
    -- no movements (present only in stored) — instead of surfacing them. The
    -- coalesce()s below are what turn "absent from this side" into the
    -- correct zero rather than a NULL that would compare as unequal to
    -- everything, including itself.
    select
      coalesce(s.prize_id, c.prize_id)   as prize_id,
      p.name                             as prize_name,
      coalesce(s.bucket, c.bucket)::text as bucket,
      coalesce(s.stored, 0)              as stored,
      coalesce(c.computed, 0)            as computed
    from stored s
    full outer join computed c
      on c.prize_id = s.prize_id and c.bucket = s.bucket
    join public.prizes p
      on p.id = coalesce(s.prize_id, c.prize_id)
    where coalesce(s.stored, 0) <> coalesce(c.computed, 0)
    order by p.name, coalesce(s.bucket, c.bucket);
end;
$$;

comment on function public.reconcile_inventory(uuid) is
  'Recomputes every (prize, bucket) balance for a Station from inventory_movements alone and returns only the rows where the stored figure in inventory_balances differs. computed(b) = sum(quantity where to_bucket = b) - sum(quantity where from_bucket = b), read from the buckets rather than movement_type, so a movement type introduced by a later Block needs no change here. It reports; it does not repair — no INSERT, UPDATE or DELETE appears in this function. A prize with movements and no balance row surfaces as stored=0 against a nonzero computed; a balance row with no movements behind it (for instance one written to directly, bypassing the ledger) surfaces as computed=0 against whatever nonzero figure is stored. Built on a FULL OUTER JOIN between the unpivoted stored balances and the unpivoted computed sums, keyed on (prize_id, bucket), specifically so a prize present on only one side is not silently dropped. Gated on inventory.view, resolved from p_company_id — never from a caller-supplied Organization id.';

revoke execute on function public.reconcile_inventory(uuid) from public;
grant execute on function public.reconcile_inventory(uuid) to authenticated;
