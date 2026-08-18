-- supabase/migrations/0228_marketing_consent_vocabulary.sql

-- Block 29c, Task 1. The vocabulary, and nothing else.
--
-- ALONE IN ITS OWN MIGRATION, which is this project's rule for ALTER TYPE ADD
-- VALUE: PostgreSQL refuses to use a new enum value in the same transaction
-- that added it, so any statement here that referenced one of these four would
-- fail on the migration's own run rather than later.
--
-- TWO CONSENT VALUES, NOT ONE. A single 'marketing' value could not express
-- "stop e-mailing me but keep the WhatsApp", which is exactly what §18 of the
-- original request asks for. Per-channel by construction beats per-channel by
-- convention.
--
-- sponsor_communication is deliberately untouched (spec D5): it names a
-- sponsor's communication rather than the Station's campaigns, nothing has ever
-- collected it, and dropping an enum value in PostgreSQL is not cheap.
alter type public.member_consent_type add value if not exists 'whatsapp_marketing' after 'sponsor_communication';
alter type public.member_consent_type add value if not exists 'email_marketing' after 'whatsapp_marketing';

-- The conversation asks, and confirms a stop. Both are system messages so a
-- Station can say them in its own voice, like everything else it says.
alter type public.system_message_key add value if not exists 'MARKETING_CONSENT' after 'COUNTRY';
alter type public.system_message_key add value if not exists 'MARKETING_STOPPED' after 'MARKETING_CONSENT';
