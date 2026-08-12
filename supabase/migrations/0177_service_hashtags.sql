-- supabase/migrations/0177_service_hashtags.sql

-- Block 19a (D6). The two hashtags a Station answers with a link.
--
-- ON widget_installations, not on integrations and not on companies, because
-- this row IS the Station's service configuration: it already holds the public
-- key the link points at, the interval between music requests, and the switch.
-- A hashtag that opens the widget belongs beside the widget it opens.
--
-- NULL IS THE CLOSED DOOR, and it is the state every Station starts in. An
-- empty string is not a second way to say the same thing: the CHECK below
-- refuses it, because '' would match nothing and read on screen as configured.

alter table public.widget_installations
  add column music_hashtag   text,
  add column service_hashtag text;

alter table public.widget_installations
  add constraint widget_installations_hashtag_shape check (
    (music_hashtag   is null or music_hashtag   ~ '^#[^[:space:]#]{1,39}$') and
    (service_hashtag is null or service_hashtag ~ '^#[^[:space:]#]{1,39}$')
  );

-- The same grammar promotions_hashtag_shape (0040) states, and stated again
-- rather than shared: a CHECK cannot reference another table's constraint, and
-- two grammars for one idea is how "#EU QUERO" becomes storable in one screen
-- and unmatched by the other.
alter table public.widget_installations
  add constraint widget_installations_hashtags_differ check (
    music_hashtag is null
    or service_hashtag is null
    or lower(music_hashtag) <> lower(service_hashtag)
  );

comment on column public.widget_installations.music_hashtag is
  'Block 19a. The hashtag that answers with a link straight into the music panel. NULL means this Station has not opened that door -- the ordinary state, and never an error. Matched case-insensitively against the first hashtag of an inbound message, AFTER the Station''s live promotions (D3).';

comment on column public.widget_installations.service_hashtag is
  'Block 19a. The hashtag that answers with a link to the widget menu, where the listener chooses between a song and a promotion. NULL means closed. Matched last of the three (D3).';

create function public.set_service_hashtags(
  p_company_id uuid,
  p_music      text,
  p_service    text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_music   text := nullif(btrim(coalesce(p_music, '')), '');
  v_service text := nullif(btrim(coalesce(p_service, '')), '');
  v_clash   text;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'set_service_hashtags denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- THE CHECK CONSTRAINTS BELOW STILL ENFORCE BOTH RULES -- they are the
  -- backstop for any writer that is not this door, the division save_show
  -- (0175) already draws between a constrained column and a door that reads
  -- like a sentence. But a CHECK violation surfaces as raw Postgres text
  -- naming widget_installations_hashtag_shape, and Task 8's screen maps
  -- 42501/22023/P0002 to sentences for an operator -- a hand-typed bad
  -- hashtag is the single most likely refusal, so it gets one here, in 22023,
  -- rather than falling through to the backstop's message.
  if v_music is not null and v_music !~ '^#[^[:space:]#]{1,39}$' then
    raise exception 'the music hashtag must start with # and hold one to thirty-nine characters with no space and no second #'
      using errcode = '22023';
  end if;

  if v_service is not null and v_service !~ '^#[^[:space:]#]{1,39}$' then
    raise exception 'the service hashtag must start with # and hold one to thirty-nine characters with no space and no second #'
      using errcode = '22023';
  end if;

  if v_music is not null and v_service is not null and lower(v_music) = lower(v_service) then
    raise exception 'the music and service hashtags must be different' using errcode = '22023';
  end if;

  -- A LIVE PROMOTION'S HASHTAG WINS THE MATCH (D3), so a Station hashtag equal
  -- to one would never answer and no screen would say why. Refused at write
  -- time, which is the only moment somebody is looking.
  --
  -- NOT "live at this instant" -- ends_at > now() alone, so a promotion that
  -- has not started yet still clashes: the day it opens it takes the tag, and
  -- the Station's hashtag would go quiet with nothing on any screen saying
  -- why. An ENDED promotion does NOT clash, or a hashtag could never be
  -- reused once any promotion had ever carried it -- precisely the trade 0040
  -- already weighed and refused for promotion-vs-promotion ("it would forbid
  -- reusing #EUQUERO next year"), and ingest_whatsapp_event (0062) only ever
  -- matches a promotion inside its own starts_at..ends_at, so an ended one
  -- could never have shadowed the Station's hashtag in the first place.
  --
  -- Scoped to this Station: a hashtag belongs to a Station, and the same tag at
  -- a sister Station is a different Station's word.
  select p.hashtag into v_clash
    from public.promotions p
   where p.company_id = p_company_id
     and p.hashtag is not null
     and p.deleted_at is null
     and p.cancelled_at is null
     and p.ends_at > now()
     and lower(p.hashtag) in (lower(coalesce(v_music, '')), lower(coalesce(v_service, '')))
   limit 1;

  if v_clash is not null then
    raise exception 'the hashtag % already belongs to a promotion of this Station', v_clash
      using errcode = '22023';
  end if;

  update public.widget_installations
     set music_hashtag   = v_music,
         service_hashtag = v_service,
         updated_at      = now()
   where company_id = p_company_id
     and deleted_at is null;

  if not found then
    raise exception 'this Station has no widget installation' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.set_service_hashtags is
  'Block 19a (D6). Writes the Station''s two service hashtags, checking templates.manage -- the permission the screen that edits them is gated on, even though the row belongs to the console. That mismatch is deliberate and the spec''s section 5 carries the reasoning: a third permission for two text fields is the mistake Block 18 documented at length. Validates shape and the differ rule itself and raises 22023 with its own sentence for each, the same division save_show (0175) draws -- the CHECK constraints stay exactly as strict and become the backstop for any other writer. Refuses a hashtag a promotion of this Station is live in now OR has not started yet (ends_at > now()); an ENDED promotion does not clash, or a hashtag already used once could never be reused (0040''s trade, weighed the same way for promotion-vs-promotion). NULL clears; an empty string is folded to NULL before any check runs, so clearing a field is never mistaken for a bad shape. A Station with no installation is refused rather than silently written to nothing: creating an installation is a console act (0159).';

revoke execute on function public.set_service_hashtags(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_service_hashtags(uuid, text, text) to authenticated;
