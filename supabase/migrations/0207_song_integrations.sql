-- supabase/migrations/0207_song_integrations.sql

-- Block 27. One song AS IT EXISTS IN THE CUSTOMER'S OWN SYSTEM: their code,
-- their spelling of the title and the artist, and their word for the category.
-- The Integration tab shows it beside ours so an operator can see, in words,
-- what a code points at.
--
-- NOT songs.external_id (0150), and the distance between the two is the reason
-- this table's key column is called `code`. external_id is Block 15's
-- API-INTAKE key — the primary key of whichever system POSTs to us, unique per
-- Station, written by the intake doors and by nothing a person touches. This is
-- the opposite direction: a description the customer exports TO us, about a
-- catalogue we never write to. Two columns whose names both said "external"
-- would be a misreading waiting to happen, which is also why songs.internal_code
-- keeps its name and only its LABEL becomes "Integration code".
--
-- A TABLE RATHER THAN THREE COLUMNS ON `songs`, and the owner's own statement of
-- the problem is the argument: several PulchatX songs may point at ONE song in
-- their system. Columns would store that description once per song and let the
-- copies drift apart silently.
--
-- LINKED BY CODE, WITH NO FOREIGN KEY. songs.internal_code already holds codes
-- with nothing behind them — all of them, on the day this ships — and a hard
-- reference would refuse to save every one of those songs. A code with no card
-- is a legitimate, permanent state, and the tab renders it as one.

create table public.song_integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  code            text not null,
  title           text,
  artist_name     text,
  category_name   text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint song_integrations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint song_integrations_code_not_blank check (btrim(code) <> '')
);

comment on table public.song_integrations is
  'A song as the customer''s own scheduling software describes it, keyed by the code songs.internal_code carries. Several songs may resolve one card, which is why the three descriptive fields live here and not on `songs`. category_name is free text and deliberately NOT a reference to music_categories: it is the other system''s vocabulary, and forcing it into ours would either refuse an import or invent categories nobody asked for. Not songs.external_id (0150), which is Block 15''s API-intake key and points the other way.';

comment on column public.song_integrations.code is
  'The customer''s own identifier, matched against songs.internal_code. Not a foreign key in either direction: every song in the catalogue predates this table, so a hard reference would refuse to save all of them.';

-- Unique among LIVE rows only, the partial shape 0150 uses for its own external
-- keys: a card can be retired and its code registered again. The write below
-- infers this index by repeating its predicate, so widening it to a plain
-- unique would silently change what a re-registration does.
create unique index song_integrations_code_live
  on public.song_integrations (company_id, code) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- RLS, exactly 0099's shape and gated on the same permission as the songs the
-- cards describe: a caller who can read the catalogue can read what the
-- customer's own system calls it.
-- ---------------------------------------------------------------------------

alter table public.song_integrations enable row level security;
revoke all on public.song_integrations from anon, authenticated;
grant select on public.song_integrations to authenticated;

create policy song_integrations_select_music_view on public.song_integrations
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- ---------------------------------------------------------------------------
-- The one door.
--
-- THERE IS NO ARCHIVE AND NO DELETE, and the absence is a decision rather than
-- an omission: a card whose code no song carries is unreachable from every
-- screen and costs nothing. Adding a retire door the day the cards need
-- managing is a migration; guessing at one now is a screen nobody asked for.
-- ---------------------------------------------------------------------------

create function public.save_song_integration(
  p_company_id uuid,
  p_code       text,
  p_title      text default null,
  p_artist     text default null,
  p_category   text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_code     text := nullif(btrim(coalesce(p_code, '')), '');
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_artist   text := nullif(btrim(coalesce(p_artist, '')), '');
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Before anything is read out of song_integrations: a caller who may not write
  -- here learns that, and learns nothing about which codes this Station holds.
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'save_song_integration denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_code is null then
    raise exception 'the card needs an integration code' using errcode = '22023';
  end if;

  -- The columns are unbounded `text`. A form's maxLength is a courtesy a caller
  -- posting straight at this RPC never sees — and one caller here is a FILE the
  -- operator supplies, which is exactly the kind of input that arrives long. The
  -- bounds match songs.internal_code's own form bound (40) and the reference
  -- tables' name bounds, so a card can never describe something the catalogue
  -- beside it could not hold.
  if length(v_code) > 40 then
    raise exception 'an integration code is at most 40 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_title, '')) > 200 then
    raise exception 'an integration title is at most 200 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_artist, '')) > 160 then
    raise exception 'an integration artist is at most 160 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_category, '')) > 160 then
    raise exception 'an integration category is at most 160 characters' using errcode = '22023';
  end if;

  -- Upsert on the LIVE unique index — the `where` repeats
  -- song_integrations_code_live's predicate, which is how Postgres infers a
  -- partial index rather than refusing the statement.
  --
  -- Every field is set on every call, the convention update_song and update_prize
  -- both follow: a partial submission blanks what it omits, which is what "the
  -- card says this" has to mean. A caller wanting to change only the title sends
  -- the other two back unchanged, exactly as the tab's form does.
  insert into public.song_integrations
    (organization_id, company_id, code, title, artist_name, category_name, created_by)
  values
    (v_org, p_company_id, v_code, v_title, v_artist, v_category, v_actor)
  on conflict (company_id, code) where deleted_at is null
  do update set title         = excluded.title,
                artist_name   = excluded.artist_name,
                category_name = excluded.category_name,
                updated_at    = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_song_integration', 'song_integrations', v_id, v_org, p_company_id,
     jsonb_build_object('code', v_code));

  return v_id;
end;
$$;

comment on function public.save_song_integration(uuid, text, text, text, text) is
  'Registers or corrects the card describing one song in the customer''s own system, keyed by (company_id, code). Gated on music.manage, checked before anything is read. Every field is set on every call, so an omitted title clears the stored one. The audit detail carries the CODE and not the three descriptive fields: those are the customer''s catalogue rather than a decision anybody made, and logging every title typed would grow the trail without telling a reader anything they could act on.';

revoke execute on function public.save_song_integration(uuid, text, text, text, text) from public;
grant  execute on function public.save_song_integration(uuid, text, text, text, text) to authenticated;
