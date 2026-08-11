-- supabase/migrations/0166_widget_music_channel.sql

-- Block 17b. ONE ADD VALUE AND NOTHING ELSE IN THIS FILE.
--
-- The Postgres rule 0082, 0091, 0151 and 0160 each paid for: ALTER TYPE ...
-- ADD VALUE cannot share a transaction with a statement that USES the value.
-- Separate files are separate transactions, and 0167 uses this one.

alter type public.music_request_channel add value 'WEB';

comment on type public.music_request_channel is
  'How a music request reached this product. MANUAL is an operator typing it; IMPORT is the legacy migration; API is Block 15''s external intake door; WEB is Block 17b -- a listener standing on the Station''s own website, through the embedded widget.';
