begin;
select plan(17);

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
-- transaction -- two rows written in one transaction carry the same timestamp,
-- and without `id desc` the winner is the planner's choice. Block 29b-1's
-- whole-branch review found this same defect one layer up.
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
  false, 'two rows at one instant resolve by id, not by the planner');

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

select finish();
rollback;
