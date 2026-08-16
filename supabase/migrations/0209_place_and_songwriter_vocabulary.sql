-- supabase/migrations/0209_place_and_songwriter_vocabulary.sql

-- Block 28. Three vocabulary changes, and NOTHING that uses their results.
--
-- The rename below would be legal beside its own uses — ALTER TYPE ... RENAME
-- VALUE does not create a value, so it carries none of ADD VALUE's restriction.
-- The two additions are not, and the house convention since 0082 (and again at
-- 0204, five migrations ago) is that enum vocabulary lands in a file that does
-- nothing else. Keeping all three here means one rule to remember rather than
-- two.

-- Block 27 shipped this as CATEGORY five migrations ago; the owner meant the
-- person who WROTE the song. Renaming the value rather than adding a sixth and
-- migrating rows: nothing outside 0205's own table refers to it, and a spare
-- CATEGORY left in the enum would be a value with no table behind it.
alter type public.music_reference_kind rename value 'CATEGORY' to 'SONGWRITER';

comment on type public.music_reference_kind is
  'The five catalogue lists that are a name and nothing else. Not the merge''s kinds (0105): that set adds SONG and does NOT include SONGWRITER — whether duplicate songwriters need collapsing is not yet known, and a merge is the one operation here that destroys. 0204 added this value as CATEGORY; 0209 renamed it, because the owner meant the person who wrote the song and never the Station''s filing word.';

-- Block 28. A listener may declare a country of their own — the diaspora case:
-- a Brazilian in Portugal listening to a Maranhão station. Lower case, matching
-- this enum's eight existing values (0040).
alter type public.promotion_requested_field add value 'country';

-- The prompt that asks for it. Upper case, matching 0109's own values. The type
-- is system_message_key, not station_message_key: 0109 named it for the SYSTEM
-- that sends the message, not for the Station that owns the wording, and every
-- override since (0113, 0114, 0180) has used that name.
alter type public.system_message_key add value 'COUNTRY';
