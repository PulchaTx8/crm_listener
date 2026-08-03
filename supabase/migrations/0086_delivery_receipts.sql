-- Block 6b, Task 5: the receipt.
--
-- The FIRST storage bucket in this project. Everything below is therefore a
-- precedent as much as a feature, and the two decisions worth naming:
--
--   * The bucket is private. A receipt is a photograph or a signature of a
--     real person, and a public bucket is a URL anybody can guess their way
--     around. The screen shows it through a signed URL minted server-side.
--   * The path carries the Station as its first segment, so the policies below
--     can decide from the name alone without joining anything. Verified in
--     psql before relying on it: storage.foldername('a/b/c.png') returns
--     {a,b}, so [1] is the Station.
--
-- The receipt is OPTIONAL and is attached AFTER the delivery is already
-- recorded (D1). Nothing here can prevent a handover from being written down.

insert into storage.buckets (id, name, public)
values ('delivery-receipts', 'delivery-receipts', false)
on conflict (id) do nothing;

-- Reading a receipt is reading a draw's outcome, so it takes the same
-- permission the winners themselves take.
create policy delivery_receipts_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'delivery-receipts'
    and public.has_permission('promotions.view',
          ((storage.foldername(name))[1])::uuid)
  );

-- Writing one is part of delivering, and takes that permission rather than the
-- reading one: somebody who may look at a Station's draws is not thereby
-- somebody who may file evidence into them.
create policy delivery_receipts_write
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'delivery-receipts'
    and public.has_permission('winners.deliver',
          ((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------------
-- Filing the path against the winner.
--
-- Separate from deliver_prize, and that separation IS D1: the delivery is
-- recorded first and this comes afterwards, so an upload that fails leaves a
-- delivery with no receipt rather than a prize that physically changed hands
-- and no record of it.

create function public.attach_delivery_receipt(p_winner_id uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_status  public.winner_status;
  v_current text;
  v_path    text := nullif(btrim(coalesce(p_path, '')), '');
begin
  select company_id, status, receipt_path
    into v_company, v_status, v_current
  from public.winners
  where id = p_winner_id
    for update;

  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  if not public.has_permission('winners.deliver', v_company) then
    raise log 'attach_delivery_receipt denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.deliver required' using errcode = '42501';
  end if;

  if v_path is null then
    raise exception 'a receipt needs a path' using errcode = '22023';
  end if;

  if v_status <> 'DELIVERED' then
    raise exception 'a prize that is % has no delivery to file a receipt against', v_status
      using errcode = '22023';
  end if;

  -- One slot. Replacing silently would overwrite a photograph of a real
  -- handover, and there is no case where that is the right thing to do without
  -- somebody saying so out loud. The only thing that clears this is erasure.
  if v_current is not null then
    raise exception 'this delivery already has a receipt' using errcode = '22023';
  end if;

  -- The path names the Station, and the storage policies above read it. A path
  -- pointing into another Station's folder would pass those policies at their
  -- own Station while filing the row here, so this is checked where the winner
  -- is known rather than left to the bucket.
  if (storage.foldername(v_path))[1] is distinct from v_company::text then
    raise exception 'a receipt belongs in its own Station''s folder' using errcode = '22023';
  end if;

  update public.winners
     set receipt_path = v_path,
         receipt_uploaded_at = now(),
         updated_at = now()
   where id = p_winner_id;
end;
$$;

comment on function public.attach_delivery_receipt(uuid, text) is
  'Files an uploaded receipt against a delivery. Gated on winners.deliver. Deliberately SEPARATE from deliver_prize, and that separation is D1: the delivery is recorded first and this runs afterwards, so an upload that fails leaves a delivery with no receipt rather than a prize that physically changed hands with no record of it. Refuses a second receipt (one slot, cleared only by erasure), a winner that is not DELIVERED, and a path whose first segment is not the winner''s own Station -- the last because the storage policies decide from the path, and a path pointing elsewhere would pass them at the wrong Station.';

revoke execute on function public.attach_delivery_receipt(uuid, text) from public;
grant execute on function public.attach_delivery_receipt(uuid, text) to authenticated;
