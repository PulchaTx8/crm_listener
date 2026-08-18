begin;
select plan(43);

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

-- Task 2. The predicate Block 29d resolves an audience with.
select has_function('public', 'members_marketing_eligible_bulk',
  array['uuid[]','uuid','public.message_channel'],
  'the set-at-a-time eligibility question exists');

-- A Station, an Organization, and four listeners in four states.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000029c1', 'Org consent');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000029c2', '00000000-0000-0000-0000-0000000029c1', 'Radio Consent');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000029a1', '00000000-0000-0000-0000-0000000029c1', 'Nunca perguntada'),
  ('00000000-0000-0000-0000-0000000029a2', '00000000-0000-0000-0000-0000000029c1', 'Disse sim'),
  ('00000000-0000-0000-0000-0000000029a3', '00000000-0000-0000-0000-0000000029c1', 'Disse sim e depois nao'),
  ('00000000-0000-0000-0000-0000000029a4', '00000000-0000-0000-0000-0000000029c1', 'Apagada');

insert into public.member_company_links (member_id, company_id, organization_id)
select id, '00000000-0000-0000-0000-0000000029c2', '00000000-0000-0000-0000-0000000029c1'
  from public.members where organization_id = '00000000-0000-0000-0000-0000000029c1';

insert into public.member_consents
  (organization_id, member_id, company_id, consent_type, granted, granted_at)
values
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', true, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a3',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', true, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a3',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', false, now() - interval '1 day');

update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000000029a4';

-- THE ASYMMETRY THIS BLOCK TURNS ON (spec D1). No row at all means NOT eligible
-- on WhatsApp, because Meta requires opt-in for a marketing template and
-- enforces it through number quality -- and eligible on e-mail, which goes out
-- on the existing relationship with one-click withdrawal.
select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'never asked means not eligible on WhatsApp');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  true, 'and eligible on e-mail, which is the whole asymmetry');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  true, 'a listener who said yes is eligible');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a3']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'and a later withdrawal beats the earlier yes');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a4']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  false, 'an erased listener is never a recipient, whatever the channel default says');

-- THE TIEBREAK. granted_at defaults to now(), which is CONSTANT within a
-- transaction -- two rows written in one transaction carry the same timestamp.
-- id cannot break the tie: it is gen_random_uuid() (0032), which carries no
-- information about which row was written later, so ordering by it is an
-- arbitrary comparison, not a tiebreak. The function instead orders by
-- granted ASC, so a tie resolves toward the refusal -- the direction that is
-- safe to be wrong in.
insert into public.member_consents
  (organization_id, member_id, company_id, consent_type, granted, granted_at)
values
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a1',
   '00000000-0000-0000-0000-0000000029c2', 'email_marketing', true,  '2026-01-01'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a1',
   '00000000-0000-0000-0000-0000000029c2', 'email_marketing', false, '2026-01-01');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  false, 'two rows at one instant resolve toward the refusal, because nothing here can say which came later');

-- AN ORGANIZATION-WIDE SUSPENSION, which is member_blocks.company_id = NULL.
-- The subtle one: a predicate matching only on equality lets this listener go
-- on receiving campaigns from every Station in the Organization.
insert into public.member_blocks (organization_id, member_id, company_id, kind, reason)
values ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
        null, 'suspension', 'probe');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'an Organization-wide suspension bars every Station in it');

-- A DRAW BAN IS NOT A SUSPENSION. member_block_kind carries both; 'draw_ban'
-- means "may not win a draw" and says nothing about messages. Barring it here
-- would punish a listener for something else entirely.
update public.member_blocks set lifted_at = now(), lift_reason = 'probe'
 where member_id = '00000000-0000-0000-0000-0000000029a2';
insert into public.member_blocks (organization_id, member_id, company_id, kind, reason)
values ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
        '00000000-0000-0000-0000-0000000029c2', 'draw_ban', 'probe');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  true, 'but a draw ban does not stop a campaign');

-- Set-at-a-time: one call, one row per member asked about, no member invented.
select is(
  (select count(*)::int from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1',
           '00000000-0000-0000-0000-0000000029a2',
           '00000000-0000-0000-0000-0000000029a3']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  3, 'one row per member asked about');

select ok(
  has_function_privilege('authenticated',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'authenticated may ask');

select ok(
  not has_function_privilege('anon',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'anon may not');

select ok(
  not has_function_privilege('public',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- Fix round 1, F7. The cold-path stop word: no live conversation, so the
-- worker resolves the listener from the phone alone.
select has_function('public', 'withdraw_marketing_by_phone',
  array['uuid', 'text'],
  'the cold-path door exists');

-- A second Station in the SAME Organization, so the scoping case below can
-- prove a phone known at one Station does not withdraw at another --
-- exactly the miss a predicate matching only on identity would produce.
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000029c5', '00000000-0000-0000-0000-0000000029c1', 'Radio Consent 2');

insert into public.integrations (id, organization_id, company_id, provider, phone_number_id, enabled) values
  ('00000000-0000-0000-0000-0000000029c6', '00000000-0000-0000-0000-0000000029c1',
   '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP', 'phone-number-id-a', true),
  ('00000000-0000-0000-0000-0000000029c7', '00000000-0000-0000-0000-0000000029c1',
   '00000000-0000-0000-0000-0000000029c5', 'WHATSAPP', 'phone-number-id-b', true);

-- 29a5's phone is stored in the LOCAL form, exactly as apply_member_creation
-- (0061) stores it for a listener this bot registered -- the ordinary case,
-- and the first of the two forms the door tries.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000029a5', '00000000-0000-0000-0000-0000000029c1',
   'Conhecida na estacao A', '11999990001');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000029a5', '00000000-0000-0000-0000-0000000029c2',
   '00000000-0000-0000-0000-0000000029c1');

-- A known phone, texted through the Station it is linked to, withdraws.
-- F8: the return is the STATION's id, not a bare true -- so the caller can
-- resolve THAT Station's own MARKETING_STOPPED wording.
select is(
  (select public.withdraw_marketing_by_phone(
     '00000000-0000-0000-0000-0000000029c6', '5511999990001')),
  '00000000-0000-0000-0000-0000000029c2'::uuid, 'a known phone withdraws, and the Station is handed back');

select is(
  (select granted from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a5' and consent_type = 'whatsapp_marketing'),
  false, 'granted is false');

select is(
  (select origin from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a5' and consent_type = 'whatsapp_marketing'),
  'stop_word', 'origin names the stop word path, apart from the conversation tap and the unsubscribe link');

-- F13. The audit row this write also makes -- the door's only write pgTAP
-- had never looked at before this round.
select is(
  (select action from public.audit_logs
    where target_table = 'member_consents'
      and target_id = (select id from public.member_consents
                         where member_id = '00000000-0000-0000-0000-0000000029a5'
                           and consent_type = 'whatsapp_marketing')),
  'withdraw_marketing_by_phone', 'the write is audited under the door''s own name');

select is(
  (select actor_id from public.audit_logs
    where target_table = 'member_consents'
      and target_id = (select id from public.member_consents
                         where member_id = '00000000-0000-0000-0000-0000000029a5'
                           and consent_type = 'whatsapp_marketing')),
  null::uuid, 'actor_id is null -- a bot-originated write, told apart from an operator''s');

select is(
  (select detail from public.audit_logs
    where target_table = 'member_consents'
      and target_id = (select id from public.member_consents
                         where member_id = '00000000-0000-0000-0000-0000000029a5'
                           and consent_type = 'whatsapp_marketing')),
  jsonb_build_object(
    'member_id', '00000000-0000-0000-0000-0000000029a5',
    'consent_id', (select id from public.member_consents
                     where member_id = '00000000-0000-0000-0000-0000000029a5'
                       and consent_type = 'whatsapp_marketing')),
  'and detail names the listener and the consent row, nothing else');

-- THE SCOPING CASE (spec D3). The same phone, texted through the OTHER
-- Station's own integration -- one this listener was never linked to.
select is(
  (select public.withdraw_marketing_by_phone(
     '00000000-0000-0000-0000-0000000029c7', '5511999990001')),
  null::uuid, 'a phone known at another Station in the group does not withdraw here');

select is(
  (select count(*)::int from public.member_consents
    where company_id = '00000000-0000-0000-0000-0000000029c5'),
  0, 'nothing was written for the Station that never linked this listener');

select is(
  (select count(*)::int from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a5' and consent_type = 'whatsapp_marketing'),
  1, 'and the earlier withdrawal at the right Station is untouched');

-- A STRANGER. No member anywhere holds this phone -- the reply a caller
-- gives has to be able to tell this apart from "withdrew".
select is(
  (select public.withdraw_marketing_by_phone(
     '00000000-0000-0000-0000-0000000029c6', '5511900000000')),
  null::uuid, 'an unknown phone reports no match');

select is(
  (select count(*)::int from public.member_consents where origin = 'stop_word'),
  1, 'and writes nothing for it');

-- THE FALLBACK FORM. 29a6's phone is stored FULL, country code and all --
-- the shape a listener registered through a different door keeps. The LOCAL
-- form the door tries first (whatsapp_local_phone strips the delivered
-- phone's country code) does not match it; only the delivered form does,
-- which is exactly the second attempt ingest_whatsapp_event (0179) already
-- falls back to, and the reason this door goes through apply_member_lookup
-- (0061) rather than one hand-written comparison.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000029a6', '00000000-0000-0000-0000-0000000029c1',
   'Conhecida com o codigo do pais', '5511999990002');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000029a6', '00000000-0000-0000-0000-0000000029c2',
   '00000000-0000-0000-0000-0000000029c1');

select is(
  (select public.withdraw_marketing_by_phone(
     '00000000-0000-0000-0000-0000000029c6', '5511999990002')),
  '00000000-0000-0000-0000-0000000029c2'::uuid,
  'the delivered form is tried when the local form does not match');

select is(
  (select count(*)::int from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a6' and consent_type = 'whatsapp_marketing'
      and origin = 'stop_word'),
  1, 'and resolves to the listener registered under the full form');

select ok(
  has_function_privilege('service_role',
    'public.withdraw_marketing_by_phone(uuid,text)', 'EXECUTE'),
  'service_role holds EXECUTE -- the worker has no other identity to call this as');

select ok(
  not has_function_privilege('anon', 'public.withdraw_marketing_by_phone(uuid,text)', 'EXECUTE'),
  'anon may not');

select ok(
  not has_function_privilege('authenticated', 'public.withdraw_marketing_by_phone(uuid,text)', 'EXECUTE'),
  'nor authenticated -- this is a worker door, not an operator one');

-- Fix round 3, F9. The in-conversation door: record_member_consent (0034)
-- is granted to authenticated only and gates on has_permission, which the
-- service-role worker calling this from src/services/conversation.ts can
-- never satisfy (auth.uid() is null). Every in-conversation write failed in
-- production until this door existed.
--
-- A FRESH member, not 29a5: that one already carries the earlier
-- withdraw_marketing_by_phone row, and granted_at defaults to now(), constant
-- within this transaction -- ordering by it would be exactly the undefined
-- tiebreak the eligibility predicate's own tests warn about, not a way to
-- find the row this insert just made.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000029a7', '00000000-0000-0000-0000-0000000029c1',
   'Respondeu na conversa', '11999990003');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000029a7', '00000000-0000-0000-0000-0000000029c2',
   '00000000-0000-0000-0000-0000000029c1');

select has_function('public', 'record_conversation_marketing_answer',
  array['uuid', 'uuid', 'boolean', 'uuid'],
  'the in-conversation door exists');

select is(
  (select public.record_conversation_marketing_answer(
     '00000000-0000-0000-0000-0000000029a7', '00000000-0000-0000-0000-0000000029c2',
     true, null)) is not null,
  true, 'it writes a row and hands back its id');

select is(
  (select granted from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a7' and consent_type = 'whatsapp_marketing'),
  true, 'granted carries through as given');

select is(
  (select origin from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a7' and consent_type = 'whatsapp_marketing'),
  'conversation', 'origin is fixed to ''conversation'' -- never a parameter, never ''stop_word''');

select is(
  (select action from public.audit_logs
    where target_table = 'member_consents'
      and target_id = (select id from public.member_consents
                         where member_id = '00000000-0000-0000-0000-0000000029a7'
                           and consent_type = 'whatsapp_marketing')),
  'record_conversation_marketing_answer', 'this write is audited under its own name too');

-- The same tenancy guard record_member_consent itself is built on: a member
-- known to the Organization but never linked to THIS Station is refused
-- rather than silently writing a consent row for a relationship that does
-- not exist.
select throws_ok($$
  select public.record_conversation_marketing_answer(
    '00000000-0000-0000-0000-0000000029a7', '00000000-0000-0000-0000-0000000029c5',
    true, null)
$$, 'P0002', null, 'a member not linked to the named Station is refused');

select ok(
  has_function_privilege('service_role',
    'public.record_conversation_marketing_answer(uuid,uuid,boolean,uuid)', 'EXECUTE'),
  'service_role holds EXECUTE on the in-conversation door too');

select ok(
  not has_function_privilege('anon',
    'public.record_conversation_marketing_answer(uuid,uuid,boolean,uuid)', 'EXECUTE'),
  'anon may not');

select ok(
  not has_function_privilege('authenticated',
    'public.record_conversation_marketing_answer(uuid,uuid,boolean,uuid)', 'EXECUTE'),
  'nor authenticated -- unlike record_member_consent, this is a worker-only door');

select finish();
rollback;
