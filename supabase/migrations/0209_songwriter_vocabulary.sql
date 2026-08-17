-- supabase/migrations/0209_songwriter_vocabulary.sql

-- Block 28. One vocabulary change, and NOTHING that uses its result.
--
-- This rename would in fact be legal beside its own uses — ALTER TYPE ... RENAME
-- VALUE does not create a value, so it carries none of ADD VALUE's restriction.
-- It travels alone anyway, on the house convention since 0082 and again at 0204:
-- enum vocabulary lands in a file that does nothing else, so there is one rule to
-- remember rather than a rule and an exception.
--
-- The country vocabulary this block also needs is NOT here, and the reason is
-- not the enum restriction — it is that a migration adding `country` would make
-- every screen that switches exhaustively on those two enums fail to compile,
-- and those screens belong to a later task. Vocabulary that lands before its
-- own code turns one task's gate red for another task's reason. It lives in
-- 0212 instead, beside the columns it exists for.

-- Block 27 shipped this as CATEGORY five migrations ago; the owner meant the
-- person who WROTE the song. Renaming the value rather than adding a sixth and
-- migrating rows: nothing outside 0205's own table refers to it, and a spare
-- CATEGORY left in the enum would be a value with no table behind it.
alter type public.music_reference_kind rename value 'CATEGORY' to 'SONGWRITER';

comment on type public.music_reference_kind is
  'The five catalogue lists that are a name and nothing else. Not the merge''s kinds (0105): that set adds SONG and does NOT include SONGWRITER — whether duplicate songwriters need collapsing is not yet known, and a merge is the one operation here that destroys. 0204 added this value as CATEGORY; 0209 renamed it, because the owner meant the person who wrote the song and never the Station''s filing word.';
