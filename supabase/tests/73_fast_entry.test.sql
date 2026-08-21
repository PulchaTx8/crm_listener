begin;
select plan(26);

-- Block 30d, item 14 (D8, D9) and the last door of item 1b (D4).
--
-- WHAT THIS FILE PINS, and it is three things that meet in one function:
--
--   1. a promotion that leaves NOTHING TO ASK OF THIS LISTENER takes the entry
--      the moment the hashtag arrives, instead of answering with a link;
--   2. the same promotion still answers with a link when the listener has a
--      requested field still to fill, because the bot has not been able to ask
--      for one since 19a -- the gate is the PAIR, not the promotion;
--   3. the reply's envelope: a template when this Station has a live
--      registration whose body wants exactly the variables the sentence has,
--      the same sentence as a session message otherwise.
--
-- AND THE NUMBER THE BOT REGISTERS A LISTENER UNDER, which 0263 left as the
-- one door still writing whatsapp_local_phone's LOCAL form. It writes
-- international_phone's answer now, and the second search it makes -- the
-- local form -- has to go on finding the listeners it registered before that.

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- TWO STATIONS. A is fully configured -- integration, enabled installation,
-- promotions -- and every fast-path assertion runs there. B has an integration
-- and a ruled promotion and NO widget installation, which is the ordinary
-- state of a Station nobody has switched the widget on for (0159), and it is
-- the placement assertion: the fast path sits AFTER the no_installation gate,
-- so B answers under its own name and enters nobody.
--
-- country = 'BR' on both. Without it international_phone returns the digits
-- unchanged (0260) and assertion 11 would pass for the wrong reason: the
-- stored value would equal the delivered one because nothing was applied, not
-- because the canonical form was.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030f0', 'Org fast entry');

insert into public.companies (id, organization_id, name, timezone, country, status) values
  ('00000000-0000-0000-0000-0000000030f5', '00000000-0000-0000-0000-0000000030f0',
   'Station A fast entry', 'America/Sao_Paulo', 'BR', 'active'),
  ('00000000-0000-0000-0000-0000000030f9', '00000000-0000-0000-0000-0000000030f0',
   'Station B (no widget installation)', 'America/Sao_Paulo', 'BR', 'active');

insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled)
values
  ('00000000-0000-0000-0000-0000000030fa', '00000000-0000-0000-0000-0000000030f0',
   '00000000-0000-0000-0000-0000000030f5', 'pw_30f5000011112222333344', true);

insert into public.integrations
  (organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f5',
   'WHATSAPP', '303030303030301', true),
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f9',
   'WHATSAPP', '303030303030302', true);

-- Promo Rapida asks for full_name and NOTHING ELSE -- no questions at all, so
-- the step list for a listener who has a name is consent and nothing more.
-- That one requested field is what makes assertion 5 possible: it is the only
-- way, with no question askable since 19a, for a step list to still hold
-- something.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, rules, requested_fields)
values
  ('00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030f0',
   '00000000-0000-0000-0000-0000000030f5', 'Promo Rapida',
   now() - interval '1 day', now() + interval '30 days',
   true, '#RAPIDO', 'Regulamento da Promo Rapida.', '{full_name}'),
  -- Asks nothing of anybody, and carries the two numbers the TOO_SOON and
  -- OVER_LIMIT sentences put in {{2}}.
  ('00000000-0000-0000-0000-0000000030fc', '00000000-0000-0000-0000-0000000030f0',
   '00000000-0000-0000-0000-0000000030f5', 'Promo Relogio',
   now() - interval '1 day', now() + interval '30 days',
   true, '#RELOGIO', 'Regulamento da Promo Relogio.', '{}'),
  ('00000000-0000-0000-0000-0000000030f8', '00000000-0000-0000-0000-0000000030f0',
   '00000000-0000-0000-0000-0000000030f9', 'Promo Sem Widget',
   now() - interval '1 day', now() + interval '30 days',
   true, '#SEMWIDGET', 'Regulamento da Promo Sem Widget.', '{}'),
  -- The same Station, still no installation, but this one ASKS for something.
  -- It is the control for assertion 9: what needs the widget still meets the
  -- gate, so a green 9 cannot be an accidentally deleted gate.
  ('00000000-0000-0000-0000-0000000030f7', '00000000-0000-0000-0000-0000000030f0',
   '00000000-0000-0000-0000-0000000030f9', 'Promo Sem Widget Que Pergunta',
   now() - interval '1 day', now() + interval '30 days',
   true, '#PEDEDADOS', 'Regulamento da Promo Sem Widget Que Pergunta.',
   '{full_name}');

-- The two numbers, set in an UPDATE rather than in the INSERT above only so
-- this comment sits beside them: promotions_repetition_shape and
-- promotions_entry_ceiling_shape both demand allow_multiple_entries, so a
-- promotion with an interval or a ceiling is necessarily one that can be
-- entered more than once.
update public.promotions
   set allow_multiple_entries = true,
       min_hours_between_entries = 2,
       max_entries_per_member = 3
 where id = '00000000-0000-0000-0000-0000000030fc';

-- Three listeners this file seeds and two the door registers itself.
--
-- 30fd carries the LOCAL form on purpose: it is a row the bot itself wrote
-- before 0267, and 0262's repair reaches only listeners linked to a Station
-- with a country. Nothing else about it is unusual.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000030f3', '00000000-0000-0000-0000-0000000030f0',
   'Ouvinte Completo', '+5511930000001'),
  ('00000000-0000-0000-0000-0000000030f6', '00000000-0000-0000-0000-0000000030f0',
   null,               '+5511930000002'),
  ('00000000-0000-0000-0000-0000000030fd', '00000000-0000-0000-0000-0000000030f0',
   'Ouvinte Legado',   '11930000003'),
  ('00000000-0000-0000-0000-0000000030fe', '00000000-0000-0000-0000-0000000030f0',
   'Ouvinte Template', '+5511930000004');

-- ---------------------------------------------------------------------------
-- The helper. One message end to end, with the event id named by the caller so
-- every assertion below can find the row it produced.
--
-- IT CATCHES, following 06_whatsapp's own ingest helper, and the reason is the
-- same: a raise inside a bare `select is(...)` aborts the whole file and
-- reports nothing about which case was responsible, while a caught one is a
-- single named failure carrying its SQLSTATE. No assertion below expects an
-- outcome beginning 'RAISED', so nothing is weakened -- and one of this file's
-- two mutation checks (the report's step 6) works by making a raise happen
-- here, which is legible only because of this.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.ingest(
  p_event_id uuid, p_wamid text, p_from text, p_text text,
  p_number text default '303030303030301')
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
  insert into public.webhook_events (id, provider, external_id, payload)
  values (p_event_id, 'WHATSAPP',
          encode(sha256(convert_to(p_wamid, 'UTF8')), 'hex'),
          jsonb_build_object(
            'metadata',     jsonb_build_object('phone_number_id', p_number),
            'from',         p_from,
            'profile_name', 'Ouvinte Bot',
            'timestamp',    extract(epoch from now())::bigint::text,
            'text',         p_text));

  begin
    v_result := public.ingest_whatsapp_event(p_event_id, 3);
  exception when others then
    v_result := jsonb_build_object(
      'outcome', 'RAISED ' || sqlstate || ': ' || sqlerrm,
      'status', null, 'participation_id', null);
  end;

  return v_result;
end $$;

-- The outbox row one message produced, found through the dedupe_key SHAPE
-- 0059 documents ('<sha256 of the wamid>:confirmation') rather than by taking
-- the newest row: the assertions below run in an order this file chooses, and
-- a lookup that could return a different message's row would pass for the
-- wrong reason.
create or replace function pg_temp.confirmation(p_wamid text)
returns public.outbox_messages language sql as $$
  select o.*
  from public.outbox_messages o
  where o.provider = 'WHATSAPP'
    and o.dedupe_key = encode(sha256(convert_to(p_wamid, 'UTF8')), 'hex') || ':confirmation';
$$;

-- ---------------------------------------------------------------------------
-- 1-4. Nothing left to ask: the entry is taken now, and the reply is the
--      sentence 0062 already wrote, sent as a session message because this
--      Station has registered no template yet (D9, first half). Every Station
--      is in that state on the day this ships.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e1', 'wamid.FAST-1',
                 '5511930000001', 'quero participar #RAPIDO') ->> 'outcome',
  'recorded',
  'nothing left to ask means the entry is taken now, not answered with a link');

select is(
  (select count(*) from public.participations
    where promotion_id = '00000000-0000-0000-0000-0000000030f2'
      and member_id = '00000000-0000-0000-0000-0000000030f3'
      and status = 'VALID'),
  1::bigint,
  'and the participation exists, written by the door itself');

select is(
  (select template_name from pg_temp.confirmation('wamid.FAST-1')),
  null,
  'with no template registered the reply goes as a session message');

select alike(
  (select body from pg_temp.confirmation('wamid.FAST-1')),
  'Pronto! Você está participando%',
  'and it carries the sentence whatsapp_reply_body already wrote');

-- ---------------------------------------------------------------------------
-- 5-6. The SAME promotion, a listener missing a field it asks for. The link is
--      still the answer: since 19a the bot cannot ask for a name, so entering
--      them would leave the promotion's own requested field empty for ever --
--      which D8 rejected in as many words.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e2', 'wamid.FAST-2',
                 '5511930000002', '#RAPIDO') ->> 'outcome',
  'link',
  'a listener with a requested field still to fill gets the link, not the entry');

select is(
  (select count(*) from public.participations
    where member_id = '00000000-0000-0000-0000-0000000030f6'),
  0::bigint,
  'and nothing was written for them: an unfollowed link costs nothing');

-- ---------------------------------------------------------------------------
-- 7-8. The pre-check's own branch, which now goes through the same envelope.
--      A second message from the listener of assertion 1 is a DUPLICATE, still
--      recorded and still answered.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e3', 'wamid.FAST-3',
                 '5511930000001', '#RAPIDO') ->> 'status',
  'DUPLICATE',
  'the same person twice is a duplicate, recorded exactly as 5a recorded it');

select alike(
  (select body from pg_temp.confirmation('wamid.FAST-3')),
  'Você já está participando%',
  'and the pre-check''s reply reaches outbox_messages through the envelope too');

-- ---------------------------------------------------------------------------
-- 9-11. PLACEMENT, and it is the whole of what fix round 1 changed. Station B
--       has an integration and a ruled, live promotion and NO widget
--       installation -- the state EVERY Station starts in, since switching the
--       widget on is a separate console act (0159).
--
--       The fast path sits ABOVE the no_installation gate, so this listener is
--       entered and answered: that gate exists because a LINK cannot be minted
--       without an installation, and this path mints none. With the gate above
--       the fast path instead -- the order this migration first shipped --
--       assertion 9 comes back `no_installation` and 10 counts zero, which is
--       the fast path dead on arrival at every freshly provisioned Station.
--
--       Assertion 11 is the other half: what still NEEDS the link still meets
--       the gate. Same Station, same missing installation, a promotion asking
--       for a field this listener has not got.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e5', 'wamid.FAST-5',
                 '5511930000005', '#SEMWIDGET', '303030303030302') ->> 'outcome',
  'recorded',
  'a Station with NO widget installation still enters a listener who has nothing left to answer: the fast path sends no link and needs no widget');

select is(
  (select count(*) from public.participations
    where promotion_id = '00000000-0000-0000-0000-0000000030f8'
      and status = 'VALID'),
  1::bigint,
  'and the entry is really there, written at a Station whose widget nobody has switched on');

select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030ea', 'wamid.FAST-10',
                 '5511930000002', '#PEDEDADOS', '303030303030302') ->> 'outcome',
  'no_installation',
  'but a listener with a field still to fill needs the widget, and without an installation that Station still finishes under its own name');

-- ---------------------------------------------------------------------------
-- 12-13. D4, the last door of item 1b. A number nobody knows: the listener the
--     bot registers carries the CANONICAL international form, the same shape
--     0263 gave the console, the spreadsheet, the widget and the API. Before
--     this migration this row would have read 11930000009.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e6', 'wamid.FAST-6',
                 '5511930000009', '#RAPIDO') ->> 'outcome',
  'recorded',
  'a newcomer the bot registers itself is entered too -- apply_member_creation fills full_name from the profile name');

select is(
  (select phone from public.members
    where organization_id = '00000000-0000-0000-0000-0000000030f0'
      and phone_normalized = '5511930000009'),
  '+5511930000009',
  'and the bot stores the CANONICAL form, not whatsapp_local_phone''s answer');

-- ---------------------------------------------------------------------------
-- 14-15. And the second search that must survive it. 30fd is stored in the
--        local form, which is what this door wrote until 0267; the canonical
--        search misses it and the local one finds it. Deleting that fallback
--        would register this listener a second time -- the split item 1b
--        exists to stop, arriving from the other direction.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e7', 'wamid.FAST-7',
                 '5511930000003', '#RAPIDO') ->> 'outcome',
  'recorded',
  'a listener the bot stored in the LOCAL form before 0267 is still resolved');

select is(
  (select count(*) from public.members
    where organization_id = '00000000-0000-0000-0000-0000000030f0'
      and phone_normalized in ('11930000003', '5511930000003')),
  1::bigint,
  'and is not registered a second time under the canonical spelling');

-- ---------------------------------------------------------------------------
-- The four registrations, and one that is deliberately wrong.
--
-- Registered HERE, after the session-message assertions above and before the
-- template one below, so both halves of D9's rule are exercised by the same
-- door on the same promotion -- the only difference between assertion 3 and
-- assertion 17 is that these rows exist.
--
-- The one at Station B uses TWO placeholders for a purpose whose sentence has
-- ONE variable. That is a thing an operator can type on the Templates screen,
-- and enqueue_whatsapp_outbound refuses it with 22023 (0111) -- which on the
-- fast path would roll back an entry already written. Assertion 25 pins that
-- the envelope declines to choose it.
-- ---------------------------------------------------------------------------
insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body, channel, internal_name)
values
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f5',
   'PARTICIPATION_CONFIRMED', 'participacao_confirmada', 'pt_BR',
   'Confirmado: {{1}}. Boa sorte!', 'WHATSAPP', 'Participacao confirmada'),
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f5',
   'PARTICIPATION_DUPLICATE', 'participacao_duplicada', 'pt_BR',
   'Você já está em {{1}}.', 'WHATSAPP', 'Participacao duplicada'),
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f5',
   'PARTICIPATION_TOO_SOON', 'participacao_cedo_demais', 'pt_BR',
   'Calma! Em {{1}} sua próxima chance é às {{2}}.', 'WHATSAPP', 'Participacao cedo demais'),
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f5',
   'PARTICIPATION_OVER_LIMIT', 'participacao_no_limite', 'pt_BR',
   'Em {{1}} você já usou suas {{2}} chances.', 'WHATSAPP', 'Participacao no limite'),
  ('00000000-0000-0000-0000-0000000030f0', '00000000-0000-0000-0000-0000000030f9',
   'PARTICIPATION_CONFIRMED', 'confirmada_errada', 'pt_BR',
   'Confirmado: {{1}} para {{2}}.', 'WHATSAPP', 'Confirmada com contrato errado');

-- ---------------------------------------------------------------------------
-- 16-18. D9, second half: a live registration whose body wants exactly the
--        variable this sentence has, so the reply goes as the template, and
--        `body` is what the APPROVED text rendered to rather than the sentence
--        the session message would have carried.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e4', 'wamid.FAST-4',
                 '5511930000004', '#RAPIDO') ->> 'outcome',
  'recorded',
  'the entry is taken the same way whichever envelope the reply travels in');

select is(
  (select template_name from pg_temp.confirmation('wamid.FAST-4')),
  'participacao_confirmada',
  'with a live registration the reply goes out as the template');

select is(
  (select body || ' | ' || template_variables::text from pg_temp.confirmation('wamid.FAST-4')),
  'Confirmado: Promo Rapida. Boa sorte! | ["Promo Rapida"]',
  'rendered from the approved body, with the promotion''s name as {{1}} -- the contract the Templates screen shows');

-- ---------------------------------------------------------------------------
-- The clock's own promotion, entered so the TOO_SOON sentence has a last
-- entry to measure from.
-- ---------------------------------------------------------------------------
select is(
  pg_temp.ingest('00000000-0000-0000-0000-0000000030e8', 'wamid.FAST-8',
                 '5511930000001', '#RELOGIO') ->> 'outcome',
  'recorded',
  'a promotion that asks nothing of anybody enters a known listener at once');

-- ---------------------------------------------------------------------------
-- 20-25. The envelope directly, over the shapes a door cannot easily produce.
--        These are the four purpose contracts the Templates screen states, and
--        every way a template can be missing.
-- ---------------------------------------------------------------------------
select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030f3',
    'TOO_SOON', '00000000-0000-0000-0000-0000000030f5') ->> 'purpose',
  null,
  'D9, the second way a template can be missing: a TOO_SOON with no computable next chance has no {{2}}, so it goes as a session message even though the template IS registered');

select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030fc', '00000000-0000-0000-0000-0000000030f3',
    'TOO_SOON', '00000000-0000-0000-0000-0000000030f5') ->> 'purpose',
  'PARTICIPATION_TOO_SOON',
  'and the same sentence with a computable next chance does go as the template');

select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030fc', '00000000-0000-0000-0000-0000000030f3',
    'TOO_SOON', '00000000-0000-0000-0000-0000000030f5') -> 'variables',
  jsonb_build_array(
    'Promo Relogio',
    (select to_char(
       (max(participated_at) + interval '2 hours') at time zone 'America/Sao_Paulo',
       'HH24:MI')
       from public.participations
      where promotion_id = '00000000-0000-0000-0000-0000000030fc'
        and member_id = '00000000-0000-0000-0000-0000000030f3'
        and status = 'VALID')),
  'TOO_SOON carries two variables in this order: the promotion, then the next chance at the STATION''s timezone');

select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030fc', '00000000-0000-0000-0000-0000000030f3',
    'OVER_LIMIT', '00000000-0000-0000-0000-0000000030f5') -> 'variables',
  jsonb_build_array('Promo Relogio', '3'),
  'OVER_LIMIT carries two: the promotion, then the ceiling');

select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030f3',
    'DUPLICATE', '00000000-0000-0000-0000-0000000030f5') -> 'variables',
  jsonb_build_array('Promo Rapida'),
  'DUPLICATE carries one: the promotion, exactly as CONFIRMED does');

select is(
  public.whatsapp_reply_envelope(
    '00000000-0000-0000-0000-0000000030f8', '00000000-0000-0000-0000-0000000030f3',
    'VALID', '00000000-0000-0000-0000-0000000030f9') ->> 'purpose',
  null,
  'a registration whose body wants two variables for a one-variable sentence is NOT chosen: enqueue_whatsapp_outbound would raise 22023 and roll back an entry already written');

-- ---------------------------------------------------------------------------
-- 26. The wrapper. Its callers want the words, and it passes a null company
--     precisely so it can never be handed a template -- with all four
--     registrations above in place, it still answers the sentence.
-- ---------------------------------------------------------------------------
select is(
  public.whatsapp_reply_body(
    '00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030f3', 'VALID'),
  'Pronto! Você está participando de Promo Rapida. Boa sorte!',
  'whatsapp_reply_body still answers the sentence, and never a template, however many are registered');

select * from finish();
rollback;
