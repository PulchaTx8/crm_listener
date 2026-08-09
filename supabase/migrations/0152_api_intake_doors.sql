-- supabase/migrations/0152_api_intake_doors.sql

-- Block 15, design D3, D4 and D8. What the two API endpoints actually call.
--
-- IT DOES NOT SHARE AN INSERT BODY WITH create_song_from_deezer (0139), AND
-- THAT IS DELIBERATE (D8). That door lets songs_deezer_live raise 23505 on
-- purpose, so the Deezer tab can say "another song is already linked to that
-- recording" -- a precise refusal an operator can act on, and 0139's own
-- comment spends a paragraph on why catching it there would be a lie. This one
-- must be IDEMPOTENT: an automation retries, and a retry must resolve to the
-- row it already created rather than raise anything at all.
--
-- Opposite semantics on purpose, so a shared body would have to branch on its
-- caller -- which is two functions wearing one name.
--
-- WHAT IS SHARED is what was already shared before this block:
-- resolve_or_create_reference (0139) and resolve_or_create_album (0137). This
-- file adds no second implementation of either.
--
-- ATOMICITY IS THE POINT, the same one 0139's header makes. This resolves up to
-- four references and then writes a song. Done from four round trips in Node,
-- any failure after the first write leaves orphan rows in a Station's catalogue
-- with nothing to explain where they came from and no screen that would show
-- them as related. A plpgsql body is one transaction; a raised exception unwinds
-- every one of them.

-- ---------------------------------------------------------------------------
-- Two tracked resolvers.
--
-- They exist ONLY to answer "did this call have to create it?", which the HTTP
-- response reports so that support can answer "where did this artist come
-- from?" six months later without opening the audit trail.
--
-- Each does a read-only pre-check and then DELEGATES to the resolver that
-- already exists. Neither copies the insert -- copying it would be exactly the
-- drift 0061's shared cores were extracted to prevent, and it would put a
-- second writer on four tables.
--
-- EXECUTE GRANTED TO NOBODY, like the resolvers they wrap.
-- ---------------------------------------------------------------------------

create function public.resolve_reference_tracked(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text,
  out reference_id uuid,
  out was_created  boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text := public.music_reference_table(p_kind);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  was_created := false;

  -- A blank name here is not a missing ARTIST -- the caller checks that, and
  -- refuses. It is a missing label or genre, both optional on a song, and both
  -- routinely absent from what Deezer's search returns.
  if v_name is null then
    reference_id := null;
    return;
  end if;

  -- The same folded match resolve_or_create_reference makes, run first so that
  -- "was it already there?" is knowable at all. format(%I) over a value THIS
  -- SCHEMA produced from an enum, never over a caller's string -- 0100's rule --
  -- and every value below is bound.
  execute format(
    'select id from public.%I
      where company_id = $1 and deleted_at is null and lower(name) = lower($2)
      order by created_at limit 1', v_table)
  into reference_id using p_company_id, v_name;

  if reference_id is not null then
    return;
  end if;

  was_created  := true;
  reference_id := public.resolve_or_create_reference(p_company_id, p_kind, v_name);
end;
$$;

comment on function public.resolve_reference_tracked(uuid, public.music_reference_kind, text) is
  'Block 15. resolve_or_create_reference, plus the one fact it does not report: whether this call had to create the row. Delegates rather than copies, so there is still one writer. EXECUTE granted to nobody.';

revoke execute on function
  public.resolve_reference_tracked(uuid, public.music_reference_kind, text) from public;

create function public.resolve_album_tracked(
  p_company_id      uuid,
  p_title           text,
  p_deezer_album_id bigint,
  p_upc             text,
  p_cover_md5       text,
  p_release_date    date,
  out album_id     uuid,
  out was_created  boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  was_created := false;

  if v_title is null then
    album_id := null;
    return;
  end if;

  -- resolve_or_create_album tries the Deezer id first and the folded title
  -- second (0137). Both are asked here, in that order, so the answer to "was it
  -- already there?" matches what that function is about to decide rather than
  -- guessing at it.
  if p_deezer_album_id is not null then
    select id into album_id
      from public.albums
     where company_id = p_company_id
       and deezer_album_id = p_deezer_album_id
       and deleted_at is null;
  end if;

  if album_id is null then
    select id into album_id
      from public.albums
     where company_id = p_company_id
       and deleted_at is null
       and lower(title) = lower(v_title)
     order by created_at
     limit 1;
  end if;

  was_created := album_id is null;

  -- CALLED EVEN WHEN THE ALBUM WAS FOUND. resolve_or_create_album gap-fills an
  -- album first typed by hand with the Deezer id, the UPC, the cover and the
  -- release date it lacked; skipping the call on a hit would throw all of that
  -- away to save one statement.
  album_id := public.resolve_or_create_album(
    p_company_id, v_title, p_deezer_album_id, p_upc, p_cover_md5, p_release_date);
end;
$$;

comment on function public.resolve_album_tracked(uuid, text, bigint, text, text, date) is
  'Block 15. resolve_or_create_album, plus whether this call had to create the album. Still calls it on a hit, because that function gap-fills what a hand-typed album lacked. EXECUTE granted to nobody.';

revoke execute on function
  public.resolve_album_tracked(uuid, text, bigint, text, text, date) from public;

-- ---------------------------------------------------------------------------
-- apply_song_intake. Design D3 and D4.
--
-- THE LADDER, and nothing else is on it:
--   1. external_id      -- the calling system's own key (D5)
--   2. deezer_track_id  -- the recording (0138's songs_deezer_live)
--   3. neither matched  -> insert
--
-- NOT ISRC. 0138's D8 refused a unique index there because the column is
-- hand-editable and one typo would become "a door nobody can open". Matching on
-- it has the same defect inverted: a wrong ISRC on an old record would silently
-- attach somebody's new request to the wrong song, and nothing would ever
-- report it.
--
-- NOT title + artist. 0098's D2 allows that duplicate deliberately -- a
-- re-recording, a live version and a remix are the same artist and the same
-- title -- and the cure is 7b's merge screen, not a wall here.
--
-- ON A HIT, GAPS ARE FILLED AND NOTHING ELSE IS TOUCHED (D3). This is the rule
-- link_song_to_deezer (0139) already applies, and its comment is the whole
-- argument: somebody who has curated a record for a year is not corrected by a
-- catalogue. `title` and `artist_id` are never among the filled columns -- they
-- are NOT NULL, so there is no gap to fill, and they are the record's identity.
--
-- NO PERMISSION CHECK HERE. Its callers have already checked a credential
-- scope, which is exactly why EXECUTE is granted to nobody.
-- ---------------------------------------------------------------------------

create function public.apply_song_intake(
  p_company_id       uuid,
  p_org              uuid,
  p_actor            uuid,
  p_external_id      text,
  p_title            text,
  p_artist_name      text,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_internal_code    text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_artist   text := nullif(btrim(coalesce(p_artist_name, '')), '');
  v_external text := nullif(btrim(coalesce(p_external_id, '')), '');
  v_code     text := nullif(btrim(coalesce(p_internal_code, '')), '');
  -- Folded before it is stored AND before it is checked: songs_isrc_shape
  -- (0138) accepts upper case only, so without this a correct ISRC sent in
  -- lower case is refused as malformed.
  v_isrc     text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
  -- 0098 checks duration_seconds > 0, and Deezer answers 0 for a handful of
  -- tracks. A 0 would fail that check and take the whole registration with it,
  -- over a field nobody asked for. 0139 makes the same substitution.
  v_duration integer := nullif(coalesce(p_duration_seconds, 0), 0);
  v_existing public.songs%rowtype;
  v_artist_id  uuid;  v_artist_new boolean := false;
  v_label_id   uuid;  v_label_new  boolean := false;
  v_genre_id   uuid;  v_genre_new  boolean := false;
  v_album_id   uuid;  v_album_new  boolean := false;
  v_filled   text[] := '{}';
  v_id       uuid;
  v_created  boolean;
begin
  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if v_artist is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds < 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  -- Rung 1. FOR UPDATE rather than a plain read, and it is load-bearing: two
  -- retries of the same request arriving together would otherwise both miss and
  -- both insert, and songs_external_live would turn the loser into a 23505 the
  -- caller can do nothing about. The lock makes the second wait and then take
  -- the gap-fill path, which is the answer it wanted.
  if v_external is not null then
    select * into v_existing from public.songs
     where company_id = p_company_id and external_id = v_external and deleted_at is null
     for update;
  end if;

  -- Rung 2.
  if v_existing.id is null and p_deezer_track_id is not null then
    select * into v_existing from public.songs
     where company_id = p_company_id and deezer_track_id = p_deezer_track_id
       and deleted_at is null
     for update;
  end if;

  if v_existing.id is not null then
    -- ------------------------------------------------------------------
    -- The hit. Only NULL columns are written, and every one that changes is
    -- named in `filled`, so the caller can see what this call actually did
    -- rather than infer it.
    -- ------------------------------------------------------------------
    v_created := false;
    v_id      := v_existing.id;

    if v_existing.label_id is null and p_label_name is not null then
      select reference_id, was_created into v_label_id, v_label_new
        from public.resolve_reference_tracked(p_company_id, 'LABEL', p_label_name);
      -- array_append rather than `|| 'label_id'`: with an untyped literal
      -- Postgres resolves `text[] || unknown` as array-to-array concatenation
      -- and fails with "malformed array literal". Caught by the test, not by
      -- review.
      if v_label_id is not null then v_filled := array_append(v_filled, 'label_id'); end if;
    else
      v_label_id := v_existing.label_id;
    end if;

    if v_existing.genre_id is null and p_genre_name is not null then
      select reference_id, was_created into v_genre_id, v_genre_new
        from public.resolve_reference_tracked(p_company_id, 'GENRE', p_genre_name);
      if v_genre_id is not null then v_filled := array_append(v_filled, 'genre_id'); end if;
    else
      v_genre_id := v_existing.genre_id;
    end if;

    if v_existing.album_id is null and p_album_title is not null then
      select album_id, was_created into v_album_id, v_album_new
        from public.resolve_album_tracked(p_company_id, p_album_title,
               p_deezer_album_id, p_upc, p_cover_md5, p_release_date);
      if v_album_id is not null then v_filled := array_append(v_filled, 'album_id'); end if;
    else
      v_album_id := v_existing.album_id;
    end if;

    if v_existing.isrc             is null and v_isrc            is not null then v_filled := array_append(v_filled, 'isrc');             end if;
    if v_existing.duration_seconds is null and v_duration        is not null then v_filled := array_append(v_filled, 'duration_seconds'); end if;
    if v_existing.nationality      is null and p_nationality     is not null then v_filled := array_append(v_filled, 'nationality');      end if;
    if v_existing.vocal            is null and p_vocal           is not null then v_filled := array_append(v_filled, 'vocal');            end if;
    if v_existing.internal_code    is null and v_code            is not null then v_filled := array_append(v_filled, 'internal_code');    end if;
    if v_existing.external_id      is null and v_external        is not null then v_filled := array_append(v_filled, 'external_id');      end if;
    if v_existing.deezer_track_id  is null and p_deezer_track_id is not null then v_filled := array_append(v_filled, 'deezer_track_id');  end if;

    -- coalesce on every column, so this statement can only ever ADD. Written as
    -- one unconditional UPDATE rather than a branch: the row is already locked
    -- FOR UPDATE, and a no-op update of it costs nothing worth an `if`.
    update public.songs s
       set label_id         = coalesce(s.label_id, v_label_id),
           genre_id         = coalesce(s.genre_id, v_genre_id),
           album_id         = coalesce(s.album_id, v_album_id),
           isrc             = coalesce(s.isrc, v_isrc),
           duration_seconds = coalesce(s.duration_seconds, v_duration),
           nationality      = coalesce(s.nationality, p_nationality),
           vocal            = coalesce(s.vocal, p_vocal),
           internal_code    = coalesce(s.internal_code, v_code),
           external_id      = coalesce(s.external_id, v_external),
           deezer_track_id  = coalesce(s.deezer_track_id, p_deezer_track_id),
           -- Only when something actually changed. A retry that fills nothing
           -- must not move updated_at, or every "recently edited" reading in the
           -- product becomes a record of the automation's polling.
           updated_at       = case when cardinality(v_filled) > 0 then now() else s.updated_at end
     where s.id = v_id;

    -- Read off the row, never resolved: a hit ignores the artist name the
    -- payload carried, so a disagreeing call must not create an artist nothing
    -- points at.
    v_artist_id := v_existing.artist_id;
  else
    -- ------------------------------------------------------------------
    -- The miss.
    -- ------------------------------------------------------------------
    v_created := true;

    select reference_id, was_created into v_artist_id, v_artist_new
      from public.resolve_reference_tracked(p_company_id, 'ARTIST', v_artist);
    select reference_id, was_created into v_label_id, v_label_new
      from public.resolve_reference_tracked(p_company_id, 'LABEL', p_label_name);
    select reference_id, was_created into v_genre_id, v_genre_new
      from public.resolve_reference_tracked(p_company_id, 'GENRE', p_genre_name);
    select album_id, was_created into v_album_id, v_album_new
      from public.resolve_album_tracked(p_company_id, p_album_title,
             p_deezer_album_id, p_upc, p_cover_md5, p_release_date);

    -- 0103's reference locks, and NOT redundant with the resolve above: this
    -- closes the window in which a row this function has just resolved is
    -- archived by a concurrent transaction before the insert lands.
    perform public.assert_song_references_live(p_company_id, v_artist_id, v_label_id, v_genre_id);

    -- NO unique_violation HANDLER. songs_deezer_live can still fire here, when
    -- two different external ids carry the same recording -- and that is a real
    -- conflict the caller must see, not one to paper over. 0139 makes the same
    -- choice for the same reason.
    insert into public.songs
      (organization_id, company_id, title, artist_id, label_id, genre_id,
       album_id, nationality, vocal, duration_seconds, internal_code,
       external_id, isrc, deezer_track_id, created_by)
    values
      (p_org, p_company_id, v_title, v_artist_id, v_label_id, v_genre_id,
       v_album_id, p_nationality, p_vocal, v_duration, v_code,
       v_external, v_isrc, p_deezer_track_id, p_actor)
    returning id into v_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (p_actor, 'api_song_intake', 'songs', v_id, p_org, p_company_id,
     jsonb_build_object(
       'created', v_created, 'filled', to_jsonb(v_filled),
       'external_id', v_external, 'deezer_track_id', p_deezer_track_id,
       -- Which references this call had to CREATE is the fact an operator asks
       -- about later -- "where did this artist come from?" -- and it is
       -- unrecoverable from the row afterwards.
       'artist_created', v_artist_new, 'label_created', v_label_new,
       'genre_created', v_genre_new, 'album_created', v_album_new));

  return jsonb_build_object(
    'song_id', v_id,
    'created', v_created,
    'filled', to_jsonb(v_filled),
    'references', jsonb_build_object(
      'artist', case when v_artist_id is null then null else
        jsonb_build_object('id', v_artist_id, 'created', v_artist_new) end,
      'label', case when v_label_id is null then null else
        jsonb_build_object('id', v_label_id, 'created', v_label_new) end,
      'genre', case when v_genre_id is null then null else
        jsonb_build_object('id', v_genre_id, 'created', v_genre_new) end,
      'album', case when v_album_id is null then null else
        jsonb_build_object('id', v_album_id, 'created', v_album_new) end));
end;
$$;

comment on function public.apply_song_intake is
  'Block 15, D3/D4. Idempotent song registration for a machine caller: external_id, then deezer_track_id, then insert. On a hit only NULL columns are written and each is named in the returned `filled`, so a caller can see what the call did. Checks no permission -- its callers check a credential scope -- so EXECUTE is granted to nobody.';

revoke execute on function public.apply_song_intake(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;

-- ---------------------------------------------------------------------------
-- api_register_song. The public half of endpoint 1.
--
-- THE GATE IS THE CREDENTIAL'S SCOPE, NOT has_permission (design D1).
-- has_permission is has_permission_for(auth.uid(), ...) since 0121, and there
-- is no auth.uid() on this path -- the route calls with the service key. Asking
-- it here would refuse every call, always, and the refusal would look to a
-- customer like a problem with their roles.
--
-- p_company_id AND p_org BOTH ARRIVE AND NEITHER IS USED. The Station is
-- re-read from the credential row, and the arguments are only checked against
-- it. The route already resolved the Station from authenticate_api_credential,
-- so passing them is redundant -- which is the point: a door that TRUSTS a
-- caller-supplied company_id is one bug in the route away from writing into
-- another Station, and that is precisely what the isolation suite exists to
-- catch. Here the mismatch is caught in the database instead.
-- ---------------------------------------------------------------------------

-- p_external_id CARRIES A DEFAULT AND SITS AFTER THE TWO REQUIRED FIELDS, which
-- is not cosmetic: a parameter without a default is generated as a REQUIRED
-- argument in src/lib/supabase/database.types.ts, and this one is genuinely
-- optional -- the Deezer consumer has no key of its own to send. Leaving it
-- required made the route unable to express "absent" without lying to the type
-- system. Found by the type checker, which is the schema saying the signature
-- was wrong.
create function public.api_register_song(
  p_credential_id    uuid,
  p_company_id       uuid,
  p_org              uuid,
  p_title            text,
  p_artist_name      text,
  p_external_id      text    default null,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_internal_code    text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_org     uuid;
begin
  -- One gated query, 0093's idiom: an unknown credential, a revoked one, an
  -- expired one, a suspended Station and a missing scope are all the same
  -- refusal from outside.
  select c.company_id, c.organization_id into v_company, v_org
  from public.api_credentials c
  join public.api_credential_scopes s
    on s.credential_id = c.id and s.permission_code = 'music.manage'
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now());

  if not found then
    raise log 'api_register_song denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- A mismatch is a fault in the ROUTE, not in the caller, and it must be loud
  -- rather than silently writing wherever the credential happens to point.
  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_register_song station mismatch: credential=% asked=%',
      p_credential_id, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  return public.apply_song_intake(
    v_company, v_org, null,
    p_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);
end;
$$;

comment on function public.api_register_song is
  'Block 15, endpoint 1. Gated on the credential''s music.manage scope, never on has_permission -- there is no auth.uid() on this path. The Station comes from the credential row; p_company_id and p_org are checked against it and never used, so a fault in the route cannot write into another Station. The actor in audit_logs is null: 0004 allows it, and 0129 states that a null there does not mean "the system did it", which is why the detail names the credential.';

revoke execute on function public.api_register_song(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;
grant execute on function public.api_register_song(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- api_record_music_request. The public half of endpoint 2.
--
-- LEAST PRIVILEGE ACROSS THREE SCOPES: music.request is required always;
-- members.create only if the listener has to be registered or linked;
-- music.manage only if the song has to be created. So a key can be issued that
-- records requests for listeners the Station already knows and touches neither
-- the catalogue nor the audience.
--
-- THE LISTENER GOES THROUGH 0061'S CORES, not through a lookup written here.
-- Those cores exist for exactly this caller -- apply_member_lookup's own
-- comment names "the WhatsApp door, which runs as service_role inside a
-- SECURITY DEFINER body where auth.uid() is NULL" -- and a third
-- implementation of "find this person by phone" is precisely the drift they
-- were extracted to prevent. apply_member_creation registers AND links, because
-- a registration IS the first Station the person took part in.
--
-- What is NOT in those cores, and so is checked here: anonymized_at.
-- apply_member_candidates filters deleted_at and nothing else, deliberately.
-- ---------------------------------------------------------------------------

create function public.api_record_music_request(
  -- p_request_external_id and p_listener_name carry defaults and sit after
  -- p_phone, for the reason api_register_song's own comment gives: a parameter
  -- with no default is generated as REQUIRED, and both of these are optional --
  -- the listener's name only when the Station already knows the phone (D6).
  p_credential_id       uuid,
  p_company_id          uuid,
  p_org                 uuid,
  p_phone               text,
  p_request_external_id text        default null,
  p_listener_name       text        default null,
  p_show_name           text        default null,
  p_requested_at        timestamptz default null,
  p_song_external_id    text    default null,
  p_title               text    default null,
  p_artist_name         text    default null,
  p_label_name          text    default null,
  p_genre_name          text    default null,
  p_album_title         text    default null,
  p_nationality         public.music_nationality default null,
  p_vocal               public.music_vocal default null,
  p_duration_seconds    integer default null,
  p_isrc                text    default null,
  p_internal_code       text    default null,
  p_deezer_track_id     bigint  default null,
  p_deezer_album_id     bigint  default null,
  p_upc                 text    default null,
  p_cover_md5           text    default null,
  p_release_date        date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company    uuid;
  v_org        uuid;
  v_scopes     text[];
  v_external   text := nullif(btrim(coalesce(p_request_external_id, '')), '');
  v_name       text := nullif(btrim(coalesce(p_listener_name, '')), '');
  v_show_name  text := nullif(btrim(coalesce(p_show_name, '')), '');
  v_member     uuid;
  v_member_new boolean := false;
  v_linked     boolean := false;
  v_anonymised boolean;
  v_show       uuid;
  v_song       jsonb;
  v_request    uuid;
  v_existing   public.music_requests%rowtype;
begin
  select c.company_id, c.organization_id,
         coalesce(array_agg(s.permission_code) filter (where s.permission_code is not null),
                  '{}'::text[])
    into v_company, v_org, v_scopes
  from public.api_credentials c
  left join public.api_credential_scopes s on s.credential_id = c.id
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
  group by c.company_id, c.organization_id;

  if not found or not ('music.request' = any(v_scopes)) then
    raise log 'api_record_music_request denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  -- The arguments are checked against the credential and never used, for the
  -- reason api_register_song gives above: a door that trusts a caller-supplied
  -- company_id is one bug in the route away from writing into another Station.
  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_record_music_request station mismatch: credential=% asked=%',
      p_credential_id, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  if public.normalize_phone(p_phone) is null then
    raise exception 'a listener must be identified by a phone number' using errcode = '22023';
  end if;

  -- IDEMPOTENCY FIRST, before anything is created. A retry must not register a
  -- listener or a song on its way to discovering that it already recorded this
  -- request -- which is exactly what would happen if this check sat lower down.
  if v_external is not null then
    select * into v_existing from public.music_requests
     where company_id = v_company and external_id = v_external and deleted_at is null;

    if found then
      return jsonb_build_object(
        'request_id', v_existing.id,
        'created', false,
        'song', jsonb_build_object('id', v_existing.song_id, 'created', false,
                                   'filled', '[]'::jsonb),
        'listener', jsonb_build_object('id', v_existing.member_id, 'created', false,
                                       'linked', true));
    end if;
  end if;

  -- The RAW phone, not the normalised one: members.phone_normalized is a
  -- generated column and both cores normalise what they are given. Handing them
  -- a pre-normalised value would make a promise about idempotence that nothing
  -- here needs -- 0033's own reasoning for passing raw arguments on.
  v_member := public.apply_member_lookup(v_org, p_phone, null, null, null);

  if v_member is not null then
    select m.anonymized_at is not null into v_anonymised
      from public.members m where m.id = v_member;

    -- 0034's erasure. Recording fresh activity against somebody who exercised
    -- it is precisely what that erasure was for, and create_music_request
    -- excludes them for the same reason. NOT recreated under a new row either:
    -- that would be the same defect wearing a different id.
    if v_anonymised then
      raise exception 'that listener has been anonymised' using errcode = '23514';
    end if;
  end if;

  if v_member is null then
    -- Design D6, the owner's ruling of 2026-08-09. The external application
    -- attends on WhatsApp and therefore holds the profile name; arriving
    -- without one is its bug, and this refuses rather than registering a
    -- nameless listener somebody has to clean up later.
    if v_name is null then
      raise exception 'a new listener must arrive with a name' using errcode = '22023';
    end if;
    if not ('members.create' = any(v_scopes)) then
      raise exception 'permission denied: members.create required' using errcode = '42501';
    end if;

    -- Every optional field is null, INCLUDING discovery_source and
    -- first_contact_origin. Those two are free text with a vocabulary the
    -- screens already read, and inventing a value here that no screen knows how
    -- to display would be worse than leaving the truth absent.
    v_member := public.apply_member_creation(
      v_company, v_name, p_phone, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null);
    v_member_new := true;
    v_linked     := true;
  else
    -- Known to the Organization already -- members are Organization-scoped
    -- (0031), so the same person entering at two of the group's Stations is one
    -- row. What has to be true is that THIS Station may see them.
    if not exists (select 1 from public.member_company_links
                    where member_id = v_member and company_id = v_company) then
      if not ('members.create' = any(v_scopes)) then
        raise exception 'permission denied: members.create required' using errcode = '42501';
      end if;
      v_linked := public.apply_member_link(v_member, v_company, v_org, null);
    end if;
  end if;

  -- The programme. RESOLVED, NEVER CREATED. `shows` is the one catalogue entity
  -- with no merge door -- 0098's table comment says so and names it as the
  -- deliberate gap -- so an API creating one from a typed name would breed
  -- duplicates with no cure. An unknown name is refused loudly rather than
  -- dropped in silence, which would record a request against no programme at
  -- all and look like it worked.
  if v_show_name is not null then
    select id into v_show from public.shows
     where company_id = v_company and deleted_at is null
       and lower(name) = lower(v_show_name)
     order by created_at limit 1;

    if not found then
      raise exception 'programme not found in this station: %', v_show_name
        using errcode = 'P0002';
    end if;
  end if;

  -- The song, by endpoint 1's rules exactly -- the same core, so the two
  -- endpoints cannot come to disagree about what registering a song means.
  v_song := public.apply_song_intake(
    v_company, v_org, null,
    p_song_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  -- Checked AFTER the intake rather than before, because whether the song has
  -- to be created is not knowable until the ladder has been walked. The whole
  -- body is one transaction, so this refusal unwinds the song it is refusing.
  if (v_song ->> 'created')::boolean and not ('music.manage' = any(v_scopes)) then
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, external_id, created_by)
  values
    (v_org, v_company, v_member, (v_song ->> 'song_id')::uuid, v_show, 'API',
     coalesce(p_requested_at, now()), v_external, null)
  returning id into v_request;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'api_record_music_request', 'music_requests', v_request, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id,
                        'member_created', v_member_new,
                        'song', v_song, 'show_id', v_show));

  return jsonb_build_object(
    'request_id', v_request,
    'created', true,
    'song', v_song,
    'listener', jsonb_build_object('id', v_member, 'created', v_member_new,
                                   'linked', v_linked));
end;
$$;

comment on function public.api_record_music_request is
  'Block 15, endpoint 2. Records what a listener asked for, registering the song by endpoint 1''s rules if the Station does not have it. Three scopes, least privilege: music.request always, members.create only to register or link a listener, music.manage only when a song has to be created. A new listener without a name is refused (D6); an anonymised one is refused and never recreated; an unknown programme is refused and never created. The listener goes through 0061''s cores, which exist for exactly this caller.';

revoke execute on function public.api_record_music_request(
  uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;
grant execute on function public.api_record_music_request(
  uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) to service_role;
