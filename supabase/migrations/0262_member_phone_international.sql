-- supabase/migrations/0262_member_phone_international.sql

-- Block 30d, D5. The listeners already stored in the local form.
--
-- NINE ROWS IN THE HOSTED DATABASE when the guard below was added,
-- 2026-08-21 -- one more than the eight this migration first measured, a
-- later WhatsApp registration having landed in between. Every one of them
-- carries first_contact_origin = 'WHATSAPP', the one path that converted an
-- inbound number to the local form before resolving the listener; the other
-- 1 005 were already international, which is why this block chose that form
-- (D2) and why this repair is nine rows rather than a thousand. SEVEN OF THE
-- NINE REPAIR CLEANLY. The other two each belong to a listener who
-- registered twice -- once by WhatsApp, once through the widget, same
-- number, same day -- so the WhatsApp row's repaired form collides with the
-- listener's own already-international widget row; the guard below leaves
-- those two exactly as they are rather than merge them (spec Sec 2).
--
-- WRITES `phone`, NOT `phone_normalized`: the latter is GENERATED from the
-- former through normalize_phone (0031) and follows on its own.
--
-- THE PREDICATE IS THE REPAIR'S OWN DEFINITION, which is what makes a second
-- run a no-op: it selects exactly the rows whose stored digits differ from what
-- the sanitation would produce. A migration re-applied by hand after a failed
-- deploy is an ordinary event in this project.
--
-- The country comes from one Station the listener is linked to -- which one is
-- the paragraph below. A listener linked to no Station, or one whose CHOSEN
-- Station carries no country, is left alone -- see the function's own comment
-- for why leaving a number alone is the safe direction. "Chosen", not "any": a
-- listener whose oldest link is to a Station with no country is skipped even
-- where a newer link would have supplied one, and that is the same answer
-- update_member gives the same listener on its next ficha save, which is the
-- point of the paragraph below.
--
-- ONE STATION PER LISTENER, AND WHICH ONE IS STATED HERE RATHER THAN LEFT TO
-- THE PLANNER. A listener linked to several Stations matches once per link, and
-- where those Stations carry different countries a bare join lets Postgres
-- apply whichever row it happens to reach. update_member (0263) answers the
-- identical question -- which country does this listener's number belong to,
-- with no company_id in hand -- with `order by l.linked_at, c.id limit 1`, and
-- explains it: oldest link first, so the answer is the Station that registered
-- them, with c.id breaking a tie between two links written in the same
-- statement. Two repairs answering one question by different rules is how they
-- come to disagree about one person: this migration would put the number in one
-- form and the next ordinary ficha save would put it in another -- and
-- phone_normalized, which decides who is who (members_phone_unique, 0031),
-- follows each time. So the rule is copied, spelled the same way.
--
-- IT IS NOT WHAT MAKES THE SECOND RUN A NO-OP, and the paragraph above must not
-- be read as claiming that. Convergence comes from international_phone's own
-- leading-plus branch: a repaired number already starts with '+', so the
-- function returns it unchanged whatever country is handed in, and the
-- predicate excludes the row under every link. The arbitrariness was about
-- WHICH form the one pass produced, not about whether a second pass settled.
--
-- THE GUARD BELOW EXISTS BECAUSE A PRODUCTION DEPLOY ALREADY FAILED ON ITS
-- ABSENCE, 2026-08-21: a listener who registered twice, once through WhatsApp
-- (the local form) and once through the widget (already international, D2),
-- has the SAME NUMBER under both rows -- so their repaired forms are
-- identical, and members_phone_unique (organization_id, phone_normalized;
-- phone_normalized generated from phone, 0031) rejected the UPDATE outright.
-- That listener is already two rows. Fusing two rows that are already one
-- listener is the merge screen's job, and the owner has not asked for a sweep
-- (spec Sec 2) -- so this migration's job is narrower than "repair every row
-- that needs it": leave a colliding row exactly as it is, and let the batch
-- finish rather than fail over one row it is not this migration's place to
-- fix.
--
-- COMPARED AS THE NORMALISED FORM OF WHAT THIS ROW WOULD BECOME, because that
-- is the value the unique index actually keys on: `other.phone_normalized`
-- against `public.normalize_phone(...)` of the same expression this UPDATE is
-- about to write into `phone`, not against `other.phone` (punctuation could
-- differ without the numbers differing) and not against this row's own
-- `phone_normalized` (a member never collides with itself; `other.id <> m.id`
-- says so, but a self-comparison would also just read back the row's OLD
-- value, since phone_normalized has not been rewritten yet at the time the
-- guard is evaluated).
--
-- TWO ROWS BOTH STILL IN THE LOCAL FORM CANNOT COLLIDE WITH EACH OTHER THIS
-- WAY, PROVIDED BOTH ARE ACTIVE. They repair onto the same value only if
-- their raw digit strings were already identical -- phone_normalized of an
-- unpunctuated local number IS that string, so two ACTIVE members already
-- holding it would already violate members_phone_unique today, before this
-- migration ever runs. "Active" is load-bearing, not decorative: the index
-- is partial on `deleted_at is null` (0031), so a soft-deleted member CAN
-- already share a phone_normalized with an active one without tripping it --
-- which is exactly why the guard's own `other.deleted_at is null` mirrors
-- the index's predicate rather than a bare equality check. Between two
-- ACTIVE rows the conclusion still holds: this migration cannot manufacture
-- that equality out of two DIFFERENT raw values within one country --
-- international_phone's national branch is a fixed prefix ('+' ||
-- calling_code) concatenated onto the untouched digit string, and
-- concatenating a fixed prefix onto different inputs cannot produce the same
-- output.
--
-- ACROSS COUNTRIES IT HOLDS FOR A NARROWER REASON, worth stating beside the
-- invitation to add one (country_phone_rule's own comment, 0260): the five
-- calling codes on file today -- 55, 351, 34, 1, 1 -- are pairwise
-- PREFIX-FREE, so '+'||code_A and '+'||code_B are guaranteed to diverge
-- somewhere inside the calling code itself, before either national number
-- even begins, whatever digits follow. A future country whose calling code
-- PREFIXES another's already on file (a hypothetical '3' beside '34' and
-- '351') would defeat this specific argument -- not the guard itself, which
-- reads the live table rather than relying on this proof and would still
-- catch whatever collision resulted, but the claim that no still-local pair
-- can ever reach one.
--
-- The only real collision measured in production is the one this guard was
-- written for: a local row reaching the value an international row already
-- holds.
with station as (
  select distinct on (l.member_id) l.member_id, c.country
    from public.member_company_links l
    join public.companies c on c.id = l.company_id
   order by l.member_id, l.linked_at, c.id
)
update public.members m
   set phone = public.international_phone(m.phone, station.country)
  from station
 where station.member_id = m.id
   and m.phone is not null
   and public.international_phone(m.phone, station.country) is distinct from m.phone
   and not exists (
     select 1
       from public.members other
      where other.organization_id = m.organization_id
        and other.id <> m.id
        and other.deleted_at is null
        and other.phone_normalized = public.normalize_phone(public.international_phone(m.phone, station.country))
   );

-- SAID OUT LOUD, so a deploy log records a deliberate skip rather than a
-- silent one. Counted AFTER the update above, over exactly the condition the
-- update itself uses to decide a row still needs repair: every row that
-- needed it and was not guarded out was fixed by the statement above, so
-- anything still failing that same test is, by construction, a row the guard
-- excluded -- no need to repeat the guard's own exists-clause here to know
-- which rows they were.
do $$
declare
  v_skipped integer;
begin
  with station as (
    select distinct on (l.member_id) l.member_id, c.country
      from public.member_company_links l
      join public.companies c on c.id = l.company_id
     order by l.member_id, l.linked_at, c.id
  )
  select count(*) into v_skipped
    from public.members m
    join station on station.member_id = m.id
   where m.phone is not null
     and public.international_phone(m.phone, station.country) is distinct from m.phone;

  if v_skipped > 0 then
    raise notice 'international_phone repair (0262): % member row(s) left in the local form -- the repaired number already belongs to a different member in the same Organization. That listener already exists as two rows; fusing them is the merge screen''s job, not this migration''s (spec Sec 2).', v_skipped;
  end if;
end $$;
