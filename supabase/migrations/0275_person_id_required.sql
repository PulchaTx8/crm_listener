-- supabase/migrations/0275_person_id_required.sql

-- THE GUARANTEE, and deliberately the last of the four.
--
-- 0273 added the column nullable and 0274 filled it. Taking the constraint
-- before either would have refused every registration the moment one door was
-- missed. Taking it in the same migration as the backfill would make a failure
-- unreadable: the constraint would report the symptom of a backfill that did not
-- finish, and whoever read the error would go looking at the wrong file.
--
-- What it buys is the only thing that separates this from a convention: a door
-- that forgets to resolve a person now fails loudly at the insert, instead of
-- leaving a profile that nothing in this schema can recognise later and nothing
-- in this schema would report.
--
-- A profile with no identifier of any kind still satisfies it: 0272 permits a
-- person carrying no claim, and 0274 gives those profiles one. That permission
-- is what makes this line possible rather than a trap.
alter table public.members
  alter column person_id set not null;
