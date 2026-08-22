-- supabase/migrations/0274_person_backfill.sql

-- EVERY LIVE PROFILE GETS A PERSON.
--
-- A FUNCTION RATHER THAN A BARE DO BLOCK, for two reasons that turned out to be
-- the same one. A test can call a function; it cannot call a DO block that ran
-- before it did, and on a fresh database this migration has nothing to do -- so
-- a test re-typing the UPDATE would pass whether or not this file existed, which
-- is a green light bolted to nothing. And a production run that stops half way
-- -- a statement timeout on a large members table is the obvious way -- can be
-- resumed by calling this again, because it only ever looks at profiles that
-- still have no person.
--
-- ORDERED BY created_at so the oldest profile mints the row and later ones join
-- it. Arbitrary in effect, since merging makes the outcome the same either way,
-- and worth fixing anyway so two runs on two databases produce the same shape.
--
-- ANONYMISED PROFILES ARE INCLUDED. They are live rows a Station still reads,
-- and 0031's own comment says the row survives so participations and deliveries
-- still reference something. Their identifiers are already gone, so they get a
-- person carrying no claim -- which 0272 permits deliberately: a person nobody
-- can recognise later is still a person, and without that 0275 could never take
-- the NOT NULL.
--
-- RETIRED PROFILES GET NOTHING. No screen reads them, their identifiers defend
-- nothing (0031's unique indexes are partial on deleted_at), and giving them a
-- claim would put it in competition with the live profile that replaced them.
--
-- D20, THE OWNER'S RULING OF 2026-08-22: keep both profiles, and retire the one
-- with fewer music requests and participations only where a contradiction cannot
-- be represented. IT IS NOT REACHED HERE, and by construction rather than by
-- luck: resolve_or_attach_person MERGES when a profile names two people, and the
-- only thing person_identifiers_live_unique forbids is two people holding one
-- live value -- which merging is precisely the resolution of. The fallback stays
-- written in the spec for a future door that attaches a claim without coming
-- through resolution.
create or replace function public.backfill_member_person_ids()
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select id, phone, email, cpf_hash, passport
      from public.members
     where deleted_at is null
       and person_id is null
     order by created_at, id
  loop
    update public.members
       set person_id = public.resolve_or_attach_person(
             r.phone, r.email, r.cpf_hash, r.passport)
     where id = r.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.backfill_member_person_ids() from public;

comment on function public.backfill_member_person_ids() is
  'Attaches a platform person to every live profile that has none, and returns how many it touched. Idempotent by its own predicate -- it only looks at profiles with a null person_id -- so a run stopped half way by a statement timeout is resumed by calling it again. A function rather than a DO block so it is reachable from a test: on a fresh database the migration that calls it has nothing to do, and a test re-typing its UPDATE would pass whether or not the migration existed. Retired profiles are skipped deliberately (0031''s identity indexes are partial on deleted_at, so their identifiers defend nothing and a claim from them would compete with the live profile that replaced them); anonymised ones are not, and get a person with no claim, which 0272 permits on purpose.';

-- The one call. Everything above exists so that this line is testable and
-- resumable rather than a one-shot nobody can re-enter.
select public.backfill_member_person_ids();
