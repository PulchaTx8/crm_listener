-- supabase/migrations/0180_service_link_messages.sql

-- Block 19a, Task 5. ONE ADD VALUE AND NOTHING ELSE IN THIS FILE.
--
-- A Station overrides a text by writing a row in station_message_templates,
-- keyed on the enum public.system_message_key -- ten values today. Three new
-- texts (the link a matched hashtag now sends, one wording per purpose) are
-- three new enum values, and ALTER TYPE ... ADD VALUE cannot share a
-- transaction with a statement that USES the value -- the same rule 0166 and
-- 0170 paid for. Separate file, and 0181 uses these.

alter type public.system_message_key add value if not exists 'LINK_MUSIC';
alter type public.system_message_key add value if not exists 'LINK_MENU';
alter type public.system_message_key add value if not exists 'LINK_PROMOTION';
