-- supabase/migrations/0204_music_category_kind.sql

-- Block 27. A fifth value for music_reference_kind, and NOTHING ELSE in this
-- file.
--
-- Postgres refuses to USE a new enum value in the same transaction that adds
-- it, and Supabase runs each migration file in its own transaction — so 0205's
-- music_reference_table() branch, which names this value in a CASE, must live
-- in a separate file or the whole migration fails with "unsafe use of new value
-- of enum type". 0082 and 0091 both paid for this already, each with a one-line
-- migration of its own; this is the third, and the pattern is now the house's.
--
-- The alternative — a lookup table instead of an enum — is not on the table for
-- one value. 0100's three doors switch on this type and its exhaustiveness is
-- what makes music_reference_table() total.

alter type public.music_reference_kind add value 'CATEGORY';

comment on type public.music_reference_kind is
  'The five catalogue lists that are a name and nothing else. Not the merge''s kinds (0105): that set adds SONG and does NOT include CATEGORY — whether duplicate categories need collapsing is not yet known, and a merge is the one operation here that destroys.';
