-- supabase/migrations/0212_country_vocabulary.sql

-- Block 28. Two vocabulary changes, and NOTHING that uses their results.
--
-- Postgres refuses to USE a new enum value in the same transaction that adds
-- it, and Supabase runs each migration file in its own transaction — so 0213's
-- member_field_value branch, which names 'country' in a CASE, must live in a
-- separate file or the whole migration fails with "unsafe use of new value of
-- enum type". 0082, 0091 and 0204 each paid for this already; this is the
-- fourth, and the pattern is the house's.
--
-- It is also why these two are NOT in 0209 beside the songwriter rename, where
-- an earlier draft had them. Both enums are switched on EXHAUSTIVELY in
-- TypeScript — FIELD_PROMPTS, FIELD_MESSAGE_KEYS and SYSTEM_MESSAGE_DEFAULTS
-- are each a total Record, deliberately, so a new value cannot be forgotten —
-- and `npm run db:types` turns a value added here into a compile error in
-- src/lib/conversation/engine.ts on the spot. Landing them three migrations
-- early made the songwriter rename's own gate red for the country's reason.

-- A listener may declare a country of their own — the diaspora case: a
-- Brazilian in Portugal listening to a Maranhão station. Lower case, matching
-- this enum's eight existing values (0040).
alter type public.promotion_requested_field add value 'country';

-- The prompt that asks for it. Upper case, matching 0109's own values. The type
-- is system_message_key, not station_message_key: 0109 named it for the SYSTEM
-- that sends the message, not for the Station that owns the wording, and every
-- override since (0113, 0114, 0180) has used that name.
alter type public.system_message_key add value 'COUNTRY';
