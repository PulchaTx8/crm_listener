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
-- The country comes from a Station the listener is linked to. A listener linked
-- to none, or to one with no country, is left alone -- see the function's own
-- comment for why leaving a number alone is the safe direction.
update public.members m
   set phone = public.international_phone(m.phone, c.country)
  from public.member_company_links l
  join public.companies c on c.id = l.company_id
 where l.member_id = m.id
   and m.phone is not null
   and public.international_phone(m.phone, c.country) is distinct from m.phone;
