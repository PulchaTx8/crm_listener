-- supabase/migrations/0167_widget_music_request.sql

-- Block 17b. The two columns and the two doors behind the widget's first
-- button.
--
-- Design: docs/superpowers/specs/2026-08-11-block-17b-widget-music-request-design.md
--
-- WHAT IS NOT HERE, and why. 17a's design says "17b is a screen and an enum
-- value" because api_record_music_request (0152) already does the work. That
-- function is gated on p_credential_id and api_credential_scopes -- which a
-- widget does not hold, it holds a signed cookie -- and it hardcodes
-- channel = 'API'. What IS inherited is apply_song_intake, the song core both
-- Block 15 endpoints call, and this file becomes its third caller so that
-- "registering a song" cannot come to mean three different things at three
-- doors. The listener needs no resolving at all: 17a's session already carries
-- member, company and organization.

alter table public.music_requests
  add column listener_note text
    constraint music_requests_note_length check (length(listener_note) <= 500);

comment on column public.music_requests.listener_note is
  'What a listener typed alongside the request, Block 17b (D3). Operator-visible only -- nothing publishes it anywhere automatically, which is the whole of the decision: moderation, and what happens when somebody writes something unbroadcastable, is a block rather than a field. Null for every request that did not arrive through the widget.';

-- NOT NULL WITH ZERO MEANING "NO CEILING", rather than nullable. Both spell
-- unlimited; having both is two representations of one fact, and it is always
-- the second one that some future WHERE clause forgets to handle.
alter table public.widget_installations
  add column music_request_cooldown interval not null default '0'
    constraint widget_installations_cooldown_not_negative
      check (music_request_cooldown >= interval '0');

comment on column public.widget_installations.music_request_cooldown is
  'How long a listener waits between music requests at this Station, Block 17b (D2). Zero is no ceiling at all. AN INTERVAL RATHER THAN A COUNT PER DAY, and that is not a preference: a count resets at a midnight somebody has to choose (companies.timezone), it cannot say how long is left, and it has to count. This compares one timestamp. Written from three form fields via make_interval(days, hours, mins) and read back with extract() -- Postgres does not normalise across those units, so 36 hours stays 36 hours and the operator reads back the numbers they typed.';

-- ---------------------------------------------------------------------------
-- The half both doors share.
--
-- A second implementation of "may this listener ask here, and how long must
-- they wait" is exactly the drift 0061's cores were extracted to prevent, and
-- there are two callers below.
-- ---------------------------------------------------------------------------
create function public.widget_music_request_context(
  p_public_key text,
  p_member_id  uuid,
  out o_company uuid,
  out o_org     uuid,
  out o_wait    integer,
  out o_reason  text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cooldown interval;
  v_last     timestamptz;
begin
  -- ONE ANSWER for unknown, disabled, archived and a suspended Station, which
  -- is the choice 0161 and 0164 already made: probing teaches nothing the
  -- iframe's `src` did not already say out loud.
  select i.company_id, i.organization_id, i.music_request_cooldown
    into o_company, o_org, v_cooldown
    from public.widget_installations i
    join public.companies c
      on c.id = i.company_id
     and c.deleted_at is null
     and c.status = 'active'
     and c.suspended_at is null
   where i.public_key = p_public_key
     and i.deleted_at is null
     and i.enabled;

  if not found then
    o_reason := 'unknown_installation';
    return;
  end if;

  -- THE LISTENER IS CHECKED AGAINST THE STATION THIS KEY NAMES, never against
  -- anything the caller supplied. The signed session already proves it; this
  -- proves it again against the database, because the widget cookie's Path is
  -- `/w` -- one path for every installation this deployment serves -- so a
  -- browser identified at Station A sends that cookie to Station B as well.
  -- api_record_music_request states the same rule in its own words: a door
  -- that trusts a caller-supplied company_id is one bug in a route away from
  -- writing into another Station.
  if not exists (
    select 1
      from public.members m
      join public.member_company_links l
        on l.member_id = m.id
       and l.company_id = o_company
     where m.id = p_member_id
       and m.organization_id = o_org
       and m.deleted_at is null
  ) then
    o_reason := 'unknown_listener';
    return;
  end if;

  -- 0034's erasure. Recording fresh activity against somebody who exercised it
  -- is precisely what that erasure was for, and it is never cured by writing
  -- the same defect under a new row.
  if exists (
    select 1 from public.members
     where id = p_member_id and anonymized_at is not null
  ) then
    o_reason := 'listener_anonymized';
    return;
  end if;

  o_wait := 0;

  if v_cooldown > interval '0' then
    -- D6: only what the widget produced. An operator recording a request on a
    -- listener's behalf does not spend that listener's web quota.
    select max(requested_at) into v_last
      from public.music_requests
     where member_id = p_member_id
       and company_id = o_company
       and channel = 'WEB'
       and deleted_at is null;

    if v_last is not null and v_last + v_cooldown > now() then
      o_wait := ceil(extract(epoch from (v_last + v_cooldown - now())))::integer;
    end if;
  end if;
end;
$$;

comment on function public.widget_music_request_context is
  'Block 17b, internal. The three refusals both widget music doors share -- unknown_installation, unknown_listener, listener_anonymized -- plus how many seconds of this Station''s cooldown are left. Not granted to anyone: the two doors below are what callers use.';

-- ---------------------------------------------------------------------------
-- The read-only door.
--
-- IT EXISTS SO NOBODY IS INVITED TO DO WORK THAT WILL BE REFUSED. Without it a
-- visitor searches, chooses a recording, writes a note and submits before
-- learning they must wait two hours. The ceiling is still enforced inside the
-- write below, because a guard only the screen respects is not a guard.
-- ---------------------------------------------------------------------------
create function public.widget_music_request_wait(
  p_public_key text,
  p_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v record;
begin
  select * into v from public.widget_music_request_context(p_public_key, p_member_id);

  -- NOT ZERO FOR A SESSION IT CANNOT VERIFY. "You may ask now" followed by a
  -- refusal at submit is a worse answer than the refusal itself, and answering
  -- a stranger's question about a listener at another Station would say whether
  -- that listener exists.
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  return jsonb_build_object('ok', true, 'wait_seconds', v.o_wait);
end;
$$;

comment on function public.widget_music_request_wait is
  'Block 17b. How many seconds before this listener may ask for a song at this Station -- zero when they may ask now. Refuses by the same names as the write, and deliberately does NOT answer zero for a session it cannot verify. Granted to service_role only.';

-- ---------------------------------------------------------------------------
-- The write.
-- ---------------------------------------------------------------------------
create function public.widget_record_music_request(
  p_public_key       text,
  p_member_id        uuid,
  p_deezer_track_id  bigint,
  p_title            text,
  p_artist_name      text,
  p_album_title      text    default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_cover_md5        text    default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_release_date     date    default null,
  p_note             text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v         record;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_song    jsonb;
  v_request uuid;
begin
  -- THE LOCK COMES BEFORE THE READ, and the order is the whole point. Without
  -- it two simultaneous submissions both read the same "last request" and both
  -- pass, which is a ceiling in name only. It is the cure widget_verify_code
  -- uses for its five-attempt ceiling; see the comment above that function's
  -- select for why a row lock rather than apply_participation's advisory one.
  perform 1 from public.members where id = p_member_id for update;

  select * into v from public.widget_music_request_context(p_public_key, p_member_id);

  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  if v.o_wait > 0 then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'wait_seconds', v.o_wait);
  end if;

  -- The same core Block 15's two endpoints call, so the three doors cannot come
  -- to disagree about what registering a song means. p_actor is null: a website
  -- visitor is not an auth.users row.
  v_song := public.apply_song_intake(
    v.o_company, v.o_org, null,
    null, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, null, null, p_duration_seconds, p_isrc,
    null, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  -- show_id null (D5): a visitor does not know a programme's name, and the API
  -- door refuses an unknown one rather than guessing, so the widget sends none.
  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, created_by, listener_note)
  values
    (v.o_org, v.o_company, p_member_id, (v_song ->> 'song_id')::uuid, null, 'WEB',
     now(), null, v_note)
  returning id into v_request;

  -- actor_id null, and 0129 states in writing that a null there does not mean
  -- "the system did it".
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'widget_record_music_request', 'music_requests', v_request, v.o_org, v.o_company,
     jsonb_build_object('public_key', p_public_key,
                        'song', v_song,
                        'has_note', v_note is not null));

  return jsonb_build_object('ok', true, 'request_id', v_request, 'song', v_song);
end;
$$;

comment on function public.widget_record_music_request is
  'Block 17b. Records what a listener asked for from the Station''s own website, registering the song through apply_song_intake if the Station does not have it. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, cooldown -- so the widget can tell a visitor which one happened. THE MEMBER ROW IS LOCKED BEFORE THE COOLDOWN IS READ: without it two simultaneous submissions both pass and the ceiling exists in name only. channel is WEB and show_id is null (D5); the audit row carries no actor because a website visitor is not an auth.users row (0129). Granted to service_role only.';

revoke execute on function public.widget_music_request_context(text, uuid) from public;
revoke execute on function public.widget_music_request_wait(text, uuid) from public;
revoke execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text,
  bigint, text, text, text, date, text) from public;

grant execute on function public.widget_music_request_wait(text, uuid) to service_role;
grant execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text,
  bigint, text, text, text, date, text) to service_role;
