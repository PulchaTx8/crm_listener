-- supabase/migrations/0188_data_deletion_requests.sql

-- The LGPD deletion request, and the protocol a person can read aloud.
--
-- NOT contact_requests WITH A FLAG. That table is where somebody asks about
-- buying the product; this one is a statutory obligation with a clock on it.
-- Sharing would put a legal deadline in the same inbox as a sales lead, and
-- would force the protocol to be the row's uuid -- which nobody can dictate
-- down a telephone, which is the one thing a protocol exists for.
--
-- THE ALPHABET HAS THE AMBIGUOUS CHARACTERS REMOVED: no O against 0, no I
-- against 1. The whole point of this string is that it survives being read
-- aloud and written down by somebody who is upset.
--
-- NOT A SEQUENCE, though a sequence would be easier still to dictate: a
-- sequential protocol publishes how many people have asked to be deleted.

-- The 32-symbol alphabet a person can be dictated over a phone call without
-- either side needing to spell anything: 0/1 and their look-alike letters
-- O/I are gone, leaving no pair this alphabet asks a tired listener to tell
-- apart by ear.
create function public.new_deletion_protocol()
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code     text := '';
  v_i        int;
begin
  for v_i in 1..8 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;

  return 'PX-' || substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
end;
$$;

comment on function public.new_deletion_protocol is
  'Block 21, Task 4. An eight-character code from a 32-symbol alphabet with O/0 and I/1 removed, formatted PX-XXXX-XXXX, so a person can read it aloud and write it back down without either side needing to spell a letter against a digit. Not a sequence: a sequential protocol would publish, to whoever asks for one, how many people have asked to have their data deleted. EXECUTE is service_role only -- the column default that calls it is only ever reached by the write path Task 5 builds.';

create type public.data_deletion_request_status as enum ('new', 'verifying', 'completed', 'refused');

-- The other unauthenticated write in the system, modelled on contact_requests
-- (0004_audit_and_contact.sql:26-37): the same name/e-mail/phone/company_name/
-- message/ip_hash/timestamps shape, plus the protocol this table exists for.
create table public.data_deletion_requests (
  id            uuid primary key default gen_random_uuid(),
  -- Generated on insert so the write path (Task 5) never has to construct
  -- one itself, and unique so a duplicate can only ever be a collision this
  -- migration refuses outright rather than a value two people share.
  protocol      text not null unique default public.new_deletion_protocol(),
  name          text not null,
  email         text not null,
  phone         text,
  company_name  text,
  message       text,
  status        public.data_deletion_request_status not null default 'new',
  ip_hash       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.data_deletion_requests is
  'Block 21, Task 4. A statutory (LGPD) deletion request from the public /delete-data page. Records the request; erases nothing -- no path from this table reaches the erasure procedure a platform admin runs by hand. Its own table rather than a flag on contact_requests, because a sales enquiry and a legal deadline do not belong in the same inbox.';
comment on column public.data_deletion_requests.protocol is
  'What the requester is given to quote back on a follow-up call or e-mail. See new_deletion_protocol() for the alphabet.';
comment on column public.data_deletion_requests.ip_hash is
  'Hashed, never the raw address (data minimisation) -- the same rule contact_requests.ip_hash carries.';

alter table public.data_deletion_requests enable row level security;

-- Default deny, exactly as 0006 opens with for every table that follows.
revoke all on public.data_deletion_requests from anon, authenticated;

-- service_role write: Task 5's public form is expected to record a request
-- the same way src/services/contact-requests.ts already records a contact
-- request, through a server-side service client rather than a direct anon
-- grant -- so, unlike contact_requests, anon holds no grant here at all.
grant select, insert, update, delete on public.data_deletion_requests to service_role;

-- authenticated reads and updates NOTHING DIRECTLY: the grant exists only so
-- that the platform-admin RLS policies below have a role to attach to, the
-- same shape contact_requests exposes to the console screen that reads it
-- (src/app/(admin)/admin/contact-requests/page.tsx, via createUserClient --
-- the caller's own session, not the service client). An authenticated
-- caller who is not a platform admin reads zero rows despite holding the
-- grant, because is_platform_admin() is what the USING clause actually
-- tests.
grant select, update on public.data_deletion_requests to authenticated;

create policy data_deletion_requests_select_admin on public.data_deletion_requests
  for select to authenticated
  using (public.is_platform_admin());

create policy data_deletion_requests_update_admin on public.data_deletion_requests
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Only service_role ever reaches the column default's EXECUTE: no anon path
-- and no authenticated path inserts a row.
revoke execute on function public.new_deletion_protocol() from public, anon, authenticated;
grant execute on function public.new_deletion_protocol() to service_role;
