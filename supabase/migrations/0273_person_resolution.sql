-- supabase/migrations/0273_person_resolution.sql

-- Nullable here and made NOT NULL in 0275, once the backfill has run and the
-- doors have been proved. A NOT NULL taken before either would refuse every
-- registration the moment one door was missed, and taken alongside the backfill
-- it would report the symptom of a backfill that did not finish rather than the
-- door that skipped resolution.
alter table public.members
  add column person_id uuid references public.people (id);

create index members_person_idx
  on public.members (person_id) where deleted_at is null;

comment on column public.members.person_id is
  'The platform person this Station profile is about (design D2). Two profiles of one human in different Organizations point at the same row, which is what makes them knowably the same human without either Station learning anything about the other.';

-- THE ONE PLACE A PLATFORM PERSON IS RESOLVED. Every write into members reaches
-- it, through the trigger at the foot of this file -- not through the four
-- registration doors, which was this migration's first design and which the NOT
-- NULL in 0275 proved insufficient: twenty-odd test files insert into members
-- directly, and a data-fixing migration eventually will too.
--
-- SECURITY INVOKER. It runs with the privileges of whoever is inserting, which
-- for every production path is a SECURITY DEFINER body that has already checked
-- its own gate -- apply_participation's convention (0054). It holds no gate of
-- its own and must not be granted to anybody: identity is not a thing a caller
-- should be able to mint on its own.
--
-- NORMALISED THROUGH normalize_phone / normalize_email, never by an expression
-- written here. 0031's comment on those two is a standing warning about exactly
-- this: a normalisation applied by whoever remembers is one that drifts, and
-- these values ARE identity -- two spellings normalising differently means
-- deduplication silently stops working and the duplicates look legitimate.
create or replace function public.resolve_or_attach_person(
  p_phone     text default null,
  p_email     text default null,
  p_cpf_hash  text default null,
  p_passport  text default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_claims  jsonb := '[]'::jsonb;
  v_person  uuid;
  v_keep    uuid;
  v_kind    text;
  v_value   text;
begin
  -- Every value this call carries, normalised and shaped like a claim. Built
  -- once so the lookup and the insert below cannot disagree about what was
  -- handed in.
  if public.normalize_phone(p_phone) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PHONE', 'value', public.normalize_phone(p_phone)));
  end if;

  if public.normalize_email(p_email) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'EMAIL', 'value', public.normalize_email(p_email)));
  end if;

  if nullif(lower(btrim(coalesce(p_cpf_hash, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'CPF', 'value', lower(btrim(p_cpf_hash))));
  end if;

  if nullif(lower(btrim(coalesce(p_passport, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PASSPORT', 'value', lower(btrim(p_passport))));
  end if;

  -- WHO ALREADY HOLDS ANY OF THEM. More than one answer is a BRIDGE: this caller
  -- names two rows that are one human, and the cheapest true thing to do is make
  -- them one. Merging is two updates and a delete because exactly two columns
  -- reference people -- 0272's comment says why that emptiness is not an
  -- accident. It is also what makes the owner's D20 fallback unnecessary here:
  -- nobody is retired, because nothing had to be refused.
  for v_person in
    select distinct pi.person_id
      from public.person_identifiers pi
      join lateral jsonb_array_elements(v_claims) c on true
     where pi.valid_to is null
       and pi.kind::text = c.value ->> 'kind'
       and pi.value      = c.value ->> 'value'
     order by 1
  loop
    if v_keep is null then
      v_keep := v_person;
    else
      update public.person_identifiers set person_id = v_keep where person_id = v_person;
      update public.members            set person_id = v_keep where person_id = v_person;
      delete from public.people where id = v_person;
    end if;
  end loop;

  if v_keep is null then
    insert into public.people default values returning id into v_keep;
  end if;

  -- Record what is not recorded yet. ON CONFLICT DO NOTHING against the live
  -- index rather than a prior select: two doors meeting one stranger at once is
  -- the ordinary case under load and not an exotic one (0063), and losing that
  -- race must not raise. The conflict can only be a claim this person already
  -- holds, since any claim held by somebody ELSE was merged into v_keep above.
  for v_kind, v_value in
    select c.value ->> 'kind', c.value ->> 'value'
      from jsonb_array_elements(v_claims) c
  loop
    insert into public.person_identifiers (person_id, kind, value)
    values (v_keep, v_kind::public.person_identifier_kind, v_value)
    on conflict do nothing;
  end loop;

  return v_keep;
end;
$$;

revoke execute on function public.resolve_or_attach_person(text, text, text, text) from public;

comment on function public.resolve_or_attach_person(text, text, text, text) is
  'The one place a platform person is resolved (design D2). Finds whoever holds any of these values live, MERGES them when the values name two rows -- one human with a profile in two Organizations is the ordinary case, and merging costs two updates because only person_identifiers and members reference people -- mints one when they name none, and records every value handed in as a live claim. Normalises through normalize_phone/normalize_email rather than repeating their expressions, for the reason 0031 gives about identity that drifts. Because it merges rather than refuses, the owner''s D20 fallback -- retire the profile with fewer requests and participations -- is never reached from here; it stays written for a future door that attaches a claim without coming through this function. SECURITY INVOKER, and reached through the members trigger rather than from the registration doors: 0275''s NOT NULL proved that "every door calls the core" is a convention rather than a rule. It runs with the privileges of whoever inserts, holds no gate of its own, and is granted to nobody. Losing a race to another door is not an error: the claim insert is ON CONFLICT DO NOTHING against the live-uniqueness index.';

-- ---------------------------------------------------------------------------
-- THE TRIGGER, and why this schema gains its SECOND one.
--
-- The first draft wired resolution into apply_member_creation, the body all four
-- registration doors share, and then 0275's NOT NULL broke twenty-odd test files
-- that insert into members directly as fixtures. That is not a test problem. It
-- is the schema saying that "every writer calls the core" is a convention, and a
-- convention cannot carry a NOT NULL: the moment one migration fixes data with a
-- plain insert, or one future door is written by somebody who did not read this
-- file, the guarantee is gone and nothing reports it.
--
-- NOT A COLUMN DEFAULT, which would have been lighter and is wrong. A default
-- can mint an empty person and satisfy the constraint, but an insert carrying a
-- telephone would then get a person holding NO claim -- deduplication would not
-- see them, and the failure would be silent and permanent. The trigger resolves
-- from the row's own values, which is the only version of this that is true.
--
-- IT ALSO REMOVED THE BLOCK'S BIGGEST RISK. With the resolution here,
-- apply_member_creation is not touched at all -- so this migration does not copy
-- a 90-line function forward, and cannot revert the country work by copying the
-- wrong generation of it. That trap was live: the definition is in 0213, not in
-- 0061 where every grep for "create or replace function" points.
--
-- BEFORE INSERT, so the resolved id is written by the insert itself rather than
-- by a second statement, and person_id is never momentarily null.
--
-- A CALLER MAY STILL SUPPLY IT. The trigger only acts when person_id is null, so
-- the backfill (0274) and any future caller that has already resolved are left
-- alone.
create or replace function public.members_attach_person()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.person_id is null then
    new.person_id := public.resolve_or_attach_person(
      new.phone, new.email, new.cpf_hash, new.passport);
  end if;
  return new;
end;
$$;

create trigger members_attach_person_before_insert
  before insert on public.members
  for each row execute function public.members_attach_person();

comment on function public.members_attach_person() is
  'Attaches a platform person to every profile written into members, whichever door or statement writes it (design D2). A trigger rather than a call inside apply_member_creation because "every writer calls the core" is a convention and 0275''s NOT NULL needs a rule: twenty-odd test files insert here directly, and a data-fixing migration eventually will too. Not a column default, which would satisfy the constraint by minting a person holding no claim -- an insert carrying a telephone would then be invisible to deduplication, silently and for ever. Acts only when person_id is null, so a caller that has already resolved is left alone.';
