-- Block 6b, Task 6: making the erasure true.
--
-- Block 3's rule is that an erasure is real. A delivery receipt is a
-- photograph or a signature -- personal data by any reading -- and until this
-- file, anonymize_member could not reach it.
--
-- THE FACT THAT SHAPES ALL OF THIS: deleting a row from storage.objects in SQL
-- removes the METADATA and leaves the file in the backing store. An erasure
-- written in SQL alone would look complete and would not be, which is worse
-- than one that visibly fails. So the SQL clears the reference and records the
-- instruction; the worker that already runs (0064) carries it out through the
-- storage API, which is the only thing that can actually delete the bytes.

create table public.storage_erasure_queue (
  id           uuid primary key default gen_random_uuid(),
  bucket       text not null,
  path         text not null,
  enqueued_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);

create index storage_erasure_queue_pending
  on public.storage_erasure_queue (enqueued_at)
  where processed_at is null;

comment on table public.storage_erasure_queue is
  'Objects that an erasure has promised to delete and that only the storage API can actually delete. Written by anonymize_member (0034, extended here) in the SAME transaction that clears the reference, so the intent cannot survive without the instruction; drained by the worker tick (0064). A row that keeps failing stays queued and visible with its last_error -- there is deliberately NO give-up threshold, because an erasure that quietly stopped trying is the single failure this table exists to prevent.';

alter table public.storage_erasure_queue enable row level security;
-- No policy: a system table, the shape whatsapp_conversations (0065) uses.

revoke all on public.storage_erasure_queue from anon, authenticated;
revoke truncate on public.storage_erasure_queue from service_role;
grant select, insert, update on public.storage_erasure_queue to service_role;

-- ---------------------------------------------------------------------------
-- anonymize_member, unchanged except that it now reaches the receipts.
--
-- Every line of Block 3's body below is byte-identical to 0034's; the only
-- addition is the receipt block, and it sits before the audit row.

create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason    public.member_erasure_reason
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  -- Not filtered on deleted_at: an already-archived listener can still be erased —
  -- archival and erasure are different mechanisms (spec §6) and neither implies the
  -- other.
  select organization_id into v_org
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.erase') then
    raise log 'anonymize_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.erase required' using errcode = '42501';
  end if;

  if p_reason is null then
    raise exception 'a reason is required to erase a listener' using errcode = '22023';
  end if;

  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;

  update public.member_notes
     set body = null
   where member_id = p_member_id and body is not null;

  update public.member_consents
     set origin = null
   where member_id = p_member_id and origin is not null;

  update public.member_blocks
     set reason = null, lift_reason = null
   where member_id = p_member_id and (reason is not null or lift_reason is not null);

  -- Block 6b. The queue row is written BEFORE the update that nulls the column
  -- it reads -- reverse the two and this erases the reference and forgets the
  -- object, which is the failure mode the queue exists to close.
  --
  -- Both statements are in this transaction, so an erasure cannot be recorded
  -- without the instruction to finish it, and the instruction cannot be issued
  -- for an erasure that rolled back.
  insert into public.storage_erasure_queue (bucket, path)
  select 'delivery-receipts', w.receipt_path
  from public.winners w
  where w.member_id = p_member_id and w.receipt_path is not null;

  update public.winners
     set receipt_path = null,
         receipt_erased_at = now(),
         updated_at = now()
   where member_id = p_member_id and receipt_path is not null;

  -- The audit entry names the event, the actor and the reason. p_reason is a bounded
  -- enum (owner's ruling A), never free text, so there is no operator prose here
  -- that could re-plant what this function just scrubbed.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'anonymize_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id, 'reason', p_reason));
end;
$$;

comment on function public.anonymize_member(uuid, public.member_erasure_reason) is
  'LGPD erasure. Nulls every identifying column on members and sets anonymized_at; the row and its id survive so participations and deliveries still reference something. Also nulls member_notes.body, member_consents.origin and member_blocks.reason/lift_reason (owner''s ruling B), keeping those rows and their dates/types/authors. EXTENDED IN 0087 to reach delivery receipts: a receipt is a photograph or a signature, so winners.receipt_path is cleared, receipt_erased_at is stamped, and the object is queued in storage_erasure_queue IN THE SAME TRANSACTION -- because deleting a storage.objects row in SQL takes only the metadata and leaves the file, so the worker (0064) is what actually deletes it. What SURVIVES an erasure, deliberately: the DELIVERY movement, its actor and its date, which are facts about stock rather than about a person. Gated on members.erase via member_reachable. The UPDATE''s own WHERE clause (anonymized_at is null) makes a double-erase a clean, atomic refusal (P0002).';
