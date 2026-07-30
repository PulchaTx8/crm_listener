-- supabase/migrations/0040_promotions.sql

-- btree_gist gives GiST the `=` operator for uuid and text, which the hashtag
-- exclusion constraint below needs in order to compare company_id and
-- lower(hashtag) alongside a range. The schema is named explicitly for the
-- reason 0001's comment gives: `create extension if not exists` without it is
-- a silent no-op against a database where the extension already lives
-- somewhere else, and that only looks like a guarantee.
create extension if not exists btree_gist with schema extensions;

-- The eight fields a promotion may ask the audience for. Each value names the
-- members column it fills, not the label on screen: the label is interface and
-- will be reworded, the column is the contract. Three fields the owner's old
-- system offered — gender, favourite station, favourite show — are deliberately
-- absent (spec D5); they have no column and will not get one.
create type public.promotion_requested_field as enum (
  'full_name', 'address', 'city', 'neighbourhood',
  'age', 'cpf', 'passport', 'discovery_source'
);

create type public.promotion_question_kind as enum (
  'QUIZ', 'MULTIPLE_CHOICE', 'ESSAY'
);

comment on type public.promotion_question_kind is
  'QUIZ has options and exactly one right answer; MULTIPLE_CHOICE has options and no right answer; ESSAY is free text and has no options at all.';

-- A CHECK constraint may not contain a subquery, and de-duplicating an array
-- needs one. Wrapping it in an immutable function is the only way to state the
-- rule in the schema rather than in prose.
create or replace function public.has_no_duplicates(p_values anyarray)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_values is null
      or cardinality(p_values) = (select count(distinct v) from unnest(p_values) as v);
$$;

comment on function public.has_no_duplicates(anyarray) is
  'True when the array holds no value twice. Exists because a CHECK cannot contain a subquery.';

create table public.promotions (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id),
  company_id            uuid not null,

  site_integration_code integer,
  name                  text not null,

  starts_at             timestamptz not null,
  ends_at               timestamptz not null,

  allow_multiple_entries    boolean not null default false,
  min_hours_between_entries integer,

  require_correct_answer boolean not null default false,
  call_to_action         text,

  whatsapp_enabled  boolean not null default false,
  hashtag           text,
  use_art           boolean not null default false,
  art_url           text,
  yes_button_label  text,
  no_button_label   text,
  requested_fields  public.promotion_requested_field[] not null default '{}',

  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id),
  cancellation_reason text,

  deleted_at  timestamptz,
  deleted_by  uuid references auth.users (id),

  constraint promotions_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint promotions_window check (ends_at > starts_at),

  constraint promotions_name_present check (length(btrim(name)) > 0),

  -- The whole of tab 2 is empty when WhatsApp is off, rather than merely
  -- ignored. A hashtag sitting on a promotion that does not use WhatsApp is a
  -- value some future reader will believe.
  constraint promotions_whatsapp_shape check (
    (whatsapp_enabled and hashtag is not null)
    or (not whatsapp_enabled
        and hashtag is null
        and use_art = false
        and art_url is null
        and yes_button_label is null
        and no_button_label is null
        and cardinality(requested_fields) = 0)
  ),

  -- A hashtag with a space in it cannot be matched against an inbound message
  -- with any confidence, and one without the leading # is not what the operator
  -- typed on the old screen. Both are refused here rather than only in the form,
  -- where just one of the two write paths would see the rule.
  constraint promotions_hashtag_shape check (
    hashtag is null or hashtag ~ '^#[^[:space:]#]{1,39}$'
  ),

  constraint promotions_art_shape check (
    (use_art and art_url is not null) or (not use_art and art_url is null)
  ),

  -- The WhatsApp Cloud API fetches this image itself and will not fetch over
  -- http. Refusing it here means the operator learns at the moment of typing,
  -- not at send time in Block 5, where nothing points back to this field.
  constraint promotions_art_https check (
    art_url is null or art_url like 'https://%'
  ),

  constraint promotions_requested_fields_distinct check (
    public.has_no_duplicates(requested_fields)
  ),

  -- 8760 hours is a year. The ceiling is arbitrary and deliberate: without one,
  -- a mistyped interval silently turns a repeatable promotion into a one-entry
  -- promotion that still advertises itself as repeatable.
  constraint promotions_repetition_shape check (
    (allow_multiple_entries and min_hours_between_entries is not null
       and min_hours_between_entries between 1 and 8760)
    or (not allow_multiple_entries and min_hours_between_entries is null)
  ),

  constraint promotions_cancellation_shape check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null
        and cancellation_reason is not null and length(btrim(cancellation_reason)) > 0)
  ),

  constraint promotions_archival_shape check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  ),

  -- The bot decides which promotion an inbound message belongs to by its
  -- hashtag alone, so two promotions accepting at the same moment in the same
  -- Station must not share one. A unique index would be too strong — it would
  -- forbid reusing #EUQUERO next year. What is actually forbidden is an
  -- OVERLAP, and tstzrange's default [) bounds mean a promotion ending at the
  -- instant another starts does not overlap it. Proved against the real
  -- database before this was written: docs/probes/block-4a-hashtag-overlap.sql.
  --
  -- Note it re-evaluates on UPDATE too, so a cancelled promotion whose window
  -- was reused can no longer be un-cancelled. Nothing here un-cancels; a future
  -- reactivate button must refuse that case with a sentence a human can act on,
  -- because the raw 23P01 reads like nothing an operator has ever seen.
  constraint promotions_hashtag_no_overlap exclude using gist (
    company_id with =,
    lower(hashtag) with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (deleted_at is null and cancelled_at is null and hashtag is not null)
);

comment on table public.promotions is
  'A promotion and its WhatsApp settings in one row. The two are not separable: forbidding two live promotions from sharing a hashtag is an exclusion constraint over the window, and an exclusion constraint cannot span two tables.';
comment on column public.promotions.requested_fields is
  'Which member fields the bot asks for. Every marked field is asked the same way, in this enum''s order — the owner was asked directly whether a field would ever need settings of its own and said no (spec D6).';
comment on column public.promotions.deleted_by is
  'Who archived it. New to this project: every other table records when a row was soft-deleted and never who. The owner resolves discrepancies himself rather than calling support, and cannot do that without a name.';
comment on column public.promotions.site_integration_code is
  'How the radio''s own website refers to this promotion. Typed by hand, optional, and unique per Station while live.';

-- Child tables prove Station membership through a composite foreign key rather
-- than trusting their own company_id, the way prizes and inventory_movements do.
alter table public.promotions
  add constraint promotions_id_company_unique unique (id, company_id);

-- The list orders by start, newest first, tie-broken by id — a keyset cursor
-- must compare exactly what it orders by (Block 3b), so the index carries both.
create index promotions_listing_idx
  on public.promotions (company_id, starts_at desc, id desc)
  where deleted_at is null;

create unique index promotions_site_code_unique
  on public.promotions (company_id, site_integration_code)
  where deleted_at is null and site_integration_code is not null;

alter table public.promotions enable row level security;

-- 0032 created this column with the comment "No foreign key yet:
-- public.promotions does not exist." It does now.
alter table public.member_consents
  add constraint member_consents_promotion_fk
  foreign key (promotion_id) references public.promotions (id);

-- A permission is born beside the feature it guards. These appear in the role
-- editor without that screen being touched; if they do not, Block 1c's catalogue
-- was built wrong and this is where we find out.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('promotions.view',    'Read promotions and their quizzes',  '4a', 'promotions', 'See promotions',                'company', 10),
  ('promotions.create',  'Register a promotion',               '4a', 'promotions', 'Register a promotion',          'company', 20),
  ('promotions.edit',    'Edit a promotion and its quiz',      '4a', 'promotions', 'Edit a promotion and its quiz', 'company', 30),
  ('promotions.cancel',  'Cancel a promotion before it ends',  '4a', 'promotions', 'Cancel a promotion',            'company', 40),
  ('promotions.archive', 'Archive a promotion',                '4a', 'promotions', 'Archive a promotion',           'company', 50);
