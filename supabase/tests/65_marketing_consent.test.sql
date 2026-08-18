begin;
select plan(4);

-- Block 29c. Consent per channel, and the two things the conversation says
-- about it. Separate values rather than one 'marketing' because §18 of the
-- original request is precisely that an e-mail opt-out must not stop WhatsApp.
select ok(
  'whatsapp_marketing' = any(enum_range(null::public.member_consent_type)::text[]),
  'a listener can consent to WhatsApp marketing');

select ok(
  'email_marketing' = any(enum_range(null::public.member_consent_type)::text[]),
  'and to e-mail marketing, separately');

select ok(
  'MARKETING_CONSENT' = any(enum_range(null::public.system_message_key)::text[]),
  'the conversation has a text for asking');

select ok(
  'MARKETING_STOPPED' = any(enum_range(null::public.system_message_key)::text[]),
  'and one for confirming a stop');

select finish();
rollback;
