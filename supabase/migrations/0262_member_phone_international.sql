-- supabase/migrations/0262_member_phone_international.sql

-- Block 30d, D5. The listeners already stored in the local form.
--
-- EIGHT ROWS IN THE HOSTED DATABASE when this was written, every one of them
-- first_contact_origin = 'WHATSAPP' -- the one path that converted an inbound
-- number to the local form before resolving the listener. The other 1 005 were
-- already international, which is why this block chose that form (D2) and why
-- this repair is eight rows rather than a thousand.
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
   and public.international_phone(m.phone, station.country) is distinct from m.phone;
