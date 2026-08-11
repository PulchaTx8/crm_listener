-- supabase/migrations/0176_widget_show_choice.sql

-- Block 18. A listener can say which programme the song is for.
--
-- THIS REVERSES 17b's D5, which said a web request carries no programme. Its
-- reason was sound at the time and is no longer true: a visitor did not know a
-- programme's name, so the widget sent none rather than guessing. Block 18 gives
-- them a list to choose from, and choosing stays optional -- somebody who just
-- wants a song played should not have to answer a question about scheduling.
--
-- THE BODY BELOW IS 0167's, EXTRACTED BY SCRIPT AND NOT RETYPED. 0167 is the
-- only definition of this function, checked before writing this. Retyping a
-- shipped body is how 0168 silently reverted 0163's public-key pin, and why
-- 0169 and 0172 were both assembled this way. The edits are only these:
--
--   * p_show_id is appended to the parameter list, so every existing positional
--     call keeps meaning what it meant.
--   * The programme is RESOLVED AGAINST THE STATION the key names before it is
--     written -- a caller-supplied id belonging to another Station must not
--     reach the row.
--   * show_id stops being the literal null the comment below described.

drop function if exists public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text,
  bigint, text, text, text, date, text);

-- ---------------------------------------------------------------------------
-- The listener's programmes: every one still on the air, with the ones playing
-- right now marked.
--
-- A DOOR OF ITS OWN, because `shows` is readable only with music.view and a
-- website visitor holds no permission at all. It applies the same three
-- refusals every widget door shares, through the context 0171 extracted.
-- ---------------------------------------------------------------------------
create function public.widget_shows(
  p_public_key text,
  p_member_id  uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v      record;
  v_live uuid[];
begin
  select * into v from public.widget_listener_context(p_public_key, p_member_id);
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  v_live := public.shows_on_air(v.o_company);

  return jsonb_build_object(
    'ok', true,
    'shows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',     s.id,
               'name',   s.name,
               -- What is on right now, so the panel can mark it. The listener
               -- still sees every programme: the owner's ruling is that
               -- somebody may ask on a Tuesday for Saturday's programme.
               'on_air', s.id = any(v_live))
             order by s.name)
        from public.shows s
       where s.company_id = v.o_company
         and s.deleted_at is null
         -- An ENDED programme is absent (D7): its past requests still name it,
         -- and nobody can make a new one. `ends_on` null is indeterminate,
         -- which is very much on the air.
         and (s.ends_on is null
              or s.ends_on >= (now() at time zone
                   (select timezone from public.companies where id = v.o_company))::date)),
      '[]'::jsonb));
end;
$$;

comment on function public.widget_shows is
  'Block 18. The Station''s programmes as the widget offers them: every one still on the air, with the ones playing right now marked. ALL of them are returned and not only today''s -- a listener may ask on a Tuesday for Saturday''s programme, which is the owner''s ruling. An ended programme is absent; its past requests still name it. Refuses by the same names as every other widget door. Granted to service_role only.';

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
  p_note             text    default null,
  -- Block 18. Appended rather than slotted in, so every existing positional
  -- call site keeps meaning what it meant. Null is "any time", which is the
  -- ordinary case: choosing a programme is optional (D6).
  p_show_id          uuid    default null
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
  v_show    uuid;
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

  -- THE PROGRAMME IS RESOLVED AGAINST THE STATION THIS KEY NAMES, never taken
  -- from the caller. A crafted id belonging to another Station would otherwise
  -- be written into this one's request -- the same rule every door in this
  -- block applies to company_id, applied to the one other id a visitor can
  -- send. An id that resolves to nothing becomes null rather than a refusal:
  -- choosing is optional (D6), so "the programme you picked has since ended"
  -- and "you picked none" are the same outcome to a listener with a song to ask
  -- for.
  --
  -- This replaces 17b's D5, which wrote a literal null here because a visitor
  -- had no way to know a programme's name. Block 18 gave them a list.
  if p_show_id is not null then
    select s.id into v_show
      from public.shows s
     where s.id = p_show_id
       and s.company_id = v.o_company
       and s.deleted_at is null;
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, created_by, listener_note)
  values
    (v.o_org, v.o_company, p_member_id, (v_song ->> 'song_id')::uuid, v_show, 'WEB',
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
  'Block 17b, extended by Block 18. Records what a listener asked for from the Station''s own website, registering the song through apply_song_intake if the Station does not have it. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, cooldown. THE MEMBER ROW IS LOCKED BEFORE THE COOLDOWN IS READ: without it two simultaneous submissions both pass. p_show_id is Block 18''s and is RESOLVED against the Station this key names before it is written -- a crafted id belonging to another Station never reaches the row, and one that resolves to nothing becomes null rather than a refusal, because choosing a programme is optional. channel is WEB; the audit row carries no actor because a website visitor is not an auth.users row (0129). Granted to service_role only.';

revoke execute on function public.widget_shows(text, uuid) from public;
revoke execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text,
  bigint, text, text, text, date, text, uuid) from public;

grant execute on function public.widget_shows(text, uuid) to service_role;
grant execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text,
  bigint, text, text, text, date, text, uuid) to service_role;
