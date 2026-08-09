-- supabase/migrations/0151_music_request_channel_api.sql

-- Block 15. ONE STATEMENT, ALONE IN ITS OWN MIGRATION, and the isolation is the
-- whole reason this file exists separately: ALTER TYPE ... ADD VALUE cannot
-- share a transaction with a statement that USES the new value. 0082 and 0091
-- each paid for that once, and 0098 predicted this very migration in its own
-- comment -- "that addition is a one-line migration of its own".
--
-- Nothing may be added to this file. 0152 is where the value is first used.
--
-- 'API' AND NOT 'WHATSAPP'. 0098 reserved WHATSAPP for this product's own bot,
-- the one that reads inbound messages through the Meta webhook. What arrives at
-- /api/v1/music-requests came over HTTP from a third party; that the third
-- party happens to attend listeners on WhatsApp is its story, not ours, and
-- labelling it WHATSAPP would make two very different paths indistinguishable
-- in every report. This column answers HOW IT REACHED US.

alter type public.music_request_channel add value 'API';
