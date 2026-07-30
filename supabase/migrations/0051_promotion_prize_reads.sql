-- supabase/migrations/0051_promotion_prize_reads.sql
--
-- The Prizes tab reads through these rather than through the tables directly,
-- and not for convenience: a prize's NAME lives in public.prizes, whose policy
-- (0029) gates every read on inventory.view. An operator holding promotions.view
-- and promotions.prizes and nothing from the inventory module would otherwise
-- get a tab of blank names — a screen that half-works for its own permission.
--
-- Both are SECURITY DEFINER and so run past RLS entirely, which means each has
-- to restate in its own body the rules the policies would have applied. That is
-- the same trap 0024's comment documents, and the archived-promotion rule below
-- is where it would have bitten.

create or replace function public.list_promotion_prizes(p_promotion_id uuid)
returns table (
  promotion_prize_id uuid,
  prize_id           uuid,
  prize_name         text,
  linked             integer,
  drawn              integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
  v_deleted timestamptz;
begin
  select p.company_id, p.deleted_at into v_company, v_deleted
  from public.promotions p
  where p.id = p_promotion_id;

  -- Returns nothing rather than raising 'not found'. An id that matches no row
  -- reads exactly like a live promotion with nothing linked to it and like an
  -- archived one seen by a delegate, so an empty tab is never by itself evidence
  -- about an id.
  --
  -- What this deliberately does NOT claim, because the permission check below
  -- makes it false: a promotion that DOES exist, in a Station where the caller
  -- holds nothing, is refused with 42501, and that does tell the caller the id
  -- is real. Folding that refusal into an empty result was the alternative and
  -- was rejected — the screen could then not tell "you may not see this" from
  -- "this promotion has no prizes", which is the one thing the tab has to say
  -- correctly — and 0049's write RPCs already give the same signal for the same
  -- ids to somebody who already holds one.
  if not found then
    return;
  end if;

  if not public.has_permission('promotions.view', v_company) then
    raise log 'list_promotion_prizes denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.view required' using errcode = '42501';
  end if;

  -- 0044's policy admits an archived promotion to the owner and the platform
  -- admin and to nobody else. This body never consults that policy, so without
  -- this the archived record's prizes would be the leak the policy closed for
  -- the record.
  if v_deleted is not null and not public.is_owner_of_company(v_company) then
    return;
  end if;

  return query
    select l.id, l.prize_id, pz.name,
           coalesce(b.linked, 0), coalesce(b.drawn, 0)
    from public.promotion_prizes l
    -- 0029's policy on prizes carries `deleted_at is null` as well as
    -- inventory.view, and this join restates NEITHER. The permission half is the
    -- whole reason this function exists. The soft-delete half is left out on
    -- purpose: archive_prize (0027) refuses while a single unit sits in any
    -- physical bucket, `linked` included, so a prize with a live link on it
    -- cannot be archived at all today and the filter could never exclude a row —
    -- a guard that cannot fire. If a later block makes that state reachable,
    -- leaving it out is still what this tab wants: hiding the link would take
    -- units that belong to a winner off the one screen that has to account for
    -- them. The picker below restates the same predicate, because there it CAN
    -- fire: a prize holding no stock is archivable.
    --
    -- No company predicate on this join either, and that is not an omission: the
    -- composite foreign key promotion_prizes_prize_fk (0045) references
    -- prizes (id, company_id) with the link's own company_id, so a link cannot
    -- name a prize from another Station structurally, and link_prize_to_promotion
    -- (0049) refuses one before it ever gets that far. The Station was decided
    -- when v_company was read from the promotion row above; adding `pz.company_id
    -- = v_company` here would restate a fact the schema already makes
    -- unrepresentable. Said out loud because the picker spells the equivalent
    -- argument out for inventory_balances, and in a file whose thesis is that a
    -- DEFINER body must restate what it bypasses, the unstated confinement is
    -- the one that erodes.
    join public.prizes pz on pz.id = l.prize_id
    -- A LEFT JOIN to the projection rather than an inner one, the same shape
    -- 0049 and 0050 both use. The two rows are written inside one transaction
    -- (apply_inventory_movement bootstraps the balance through
    -- ensure_promotion_prize_balance_row, 0047), so a link without its
    -- projection row is not a state any reader can observe today; the join is
    -- written this way so that if one ever appears the link reads as zeros on
    -- the tab instead of vanishing from it silently, which is the version of
    -- that failure nobody would notice.
    left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
    -- Restates 0046's policy, which bakes `deleted_at is null` in: a link
    -- unwound to nothing leaves the tab rather than sitting there as a row of
    -- zeros, and its history is in the ledger.
    where l.promotion_id = p_promotion_id and l.deleted_at is null
    -- The link id breaks ties, because prize names are not unique in a Station:
    -- only internal_code is (0027). Two prizes sharing a name would otherwise
    -- swap places between two renders of the same unchanged tab.
    order by pz.name, l.id;
end;
$$;

comment on function public.list_promotion_prizes(uuid) is
  'One row per live link on a promotion: the prize, its name, and the two figures the owner''s screen calls Vinculados and Sorteados. Resto is linked - drawn and is computed on screen, never stored — a stored total is one more thing that can disagree with its parts. Gated on promotions.view, resolved from the promotion row. SECURITY DEFINER on purpose: the prize name is unreadable to a caller without inventory.view, and the Prizes tab must work for somebody who holds only the promotions codes. Returns nothing for a promotion that does not exist, for one with no live links, and for an archived one unless the caller is the owner or the platform admin — the same rule 0044''s policy applies to the record, restated because a DEFINER body never consults it. A caller holding no promotions.view in the Station that owns the promotion is refused with 42501 rather than read as empty, so an id that exists is distinguishable from one that does not: that is deliberate, because the tab has to be able to say "you may not see this" rather than show an empty list, and it is the same signal 0049''s write RPCs already give to whoever already holds the id. A LEFT JOIN to the projection, so a link whose balance row is somehow missing reads as zeros rather than vanishing.';

create or replace function public.list_linkable_prizes(
  p_company_id uuid,
  p_search     text default null
)
returns table (
  prize_id  uuid,
  name      text,
  available integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- promotions.prizes rather than promotions.view: this list exists to be
  -- linked from, and showing somebody the Station's stock is not something
  -- reading a promotion should carry with it.
  if not public.has_permission('promotions.prizes', p_company_id) then
    raise log 'list_linkable_prizes denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  return query
    select pz.id, pz.name, coalesce(b.available, 0)
    from public.prizes pz
    -- Both halves of this join are confined to p_company_id: the prize by the
    -- where clause below, the balance by the prize it hangs off. That
    -- confinement is the whole of what stands between a DEFINER read of
    -- inventory_balances and a cross-Station one, because the policy that would
    -- otherwise have done it (0029, gated on inventory.view) is not consulted
    -- here and cannot be.
    left join public.inventory_balances b
      on b.company_id = pz.company_id and b.prize_id = pz.id
    where pz.company_id = p_company_id
      and pz.deleted_at is null
      -- A plain substring rather than ILIKE with the term interpolated: a
      -- search for "50%" is a search for "50%", not for everything beginning
      -- with 50. No escaping to get wrong, because there are no
      -- metacharacters to escape.
      and (v_search is null or position(lower(v_search) in lower(pz.name)) > 0)
    -- The prize id breaks ties for the same reason it does above, and it matters
    -- more here: names are not unique in a Station, and a tie straddling the cut
    -- below would decide which of two prizes the operator is even offered.
    order by pz.name, pz.id
    -- Fifty-one for a list of fifty, the house idiom: listPromotionsPage
    -- (src/services/promotions.ts) reads PROMOTION_PAGE_SIZE + 1 and keysetPage
    -- (src/lib/keyset.ts) treats the extra row as "there is more" and drops it
    -- before rendering. The caller takes the first fifty and reads a fifty-first
    -- row as the signal that the list was cut.
    --
    -- A bare `limit 50` was what this shipped as, and it was wrong: fifty rows
    -- would have meant "cut, probably" over a Station holding exactly fifty
    -- prizes, so the screen would have announced a truncation that did not
    -- happen — a false statement to the operator rather than a cautious one.
    -- Over-fetching one makes the signal exact in both directions and costs one
    -- row. Returning a total alongside was the other alternative and stays
    -- rejected: a second count over the catalogue on every keystroke of the
    -- search, to refine a message that reads the same either way.
    --
    -- The search does NOT escape this cap and never did — it runs through the
    -- same query, so a term matching sixty prizes is cut at fifty and signals it
    -- the same way. What the search is for is reaching a prize that sorts past
    -- the window, not seeing more than fifty at once.
    limit 51;
end;
$$;

comment on function public.list_linkable_prizes(uuid, text) is
  'The prize picker behind the Link control: every live prize in the Station with its available count, ordered by name (the prize id breaks ties, since names are not unique in a Station) and windowed at 50. It returns up to 51 rows, the house over-fetch idiom listPromotionsPage and keysetPage already use: the caller renders the first 50 and reads a 51st row as the signal that the list was cut, which is exact in both directions — a Station holding exactly 50 prizes returns 50 and must not be told it was truncated. The search runs through the same window and does not escape it; it is how somebody reaches a prize that sorts past the fifty, not how they see more than fifty. Prizes with zero available are included on purpose: hiding one would leave an operator hunting for a prize they can see on the inventory screen, and link_prize_to_promotion refuses the quantity anyway, naming the figure. Gated on promotions.prizes rather than promotions.view — showing somebody the Station''s stock is not something reading a promotion should carry with it — and SECURITY DEFINER for the same reason as list_promotion_prizes: the caller may hold nothing from the inventory module. The search is a plain substring match, not a LIKE pattern, so a term containing % or _ is a term.';

revoke execute on function public.list_promotion_prizes(uuid)      from public;
revoke execute on function public.list_linkable_prizes(uuid, text) from public;

grant execute on function public.list_promotion_prizes(uuid)      to authenticated;
grant execute on function public.list_linkable_prizes(uuid, text) to authenticated;
