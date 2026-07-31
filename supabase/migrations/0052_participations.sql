-- supabase/migrations/0052_participations.sql

-- Four outcomes, one column. The brainstorming sketch had three statuses and a
-- free-text reason beside them, and it was replaced for two reasons: the reason
-- would have to be parsed to answer "show me everything refused for coming in
-- too early", which is a question the screen will be asked; and DUPLICATE would
-- have appeared both as a status and as a reason, so two columns would encode
-- one fact and could disagree.
create type public.participation_status as enum (
  'VALID', 'DUPLICATE', 'TOO_SOON', 'OVER_LIMIT'
);

comment on type public.participation_status is
  'What happened to an attempt. Never says whether the quiz was answered correctly — that is a draw-time question (Block 6) read off the answers, and a wrong answer refuses nobody.';

-- Block 5 adds WHATSAPP. Deliberately separate from status: how somebody entered
-- and whether it counted are independent, and every combination of the two is
-- real.
create type public.participation_source as enum ('MANUAL', 'IMPORT');

-- The ceiling D1 asked for. Meaningful only where repeats are already allowed,
-- and never one: a ceiling of one is what allow_multiple_entries = false already
-- says, and two ways to say one thing is one way too many.
alter table public.promotions
  add column max_entries_per_member integer;

alter table public.promotions
  add constraint promotions_entry_ceiling_shape check (
    max_entries_per_member is null
    or (allow_multiple_entries and max_entries_per_member >= 2)
  );

comment on column public.promotions.max_entries_per_member is
  'How many times one person may enter. Null means no ceiling. Counted under the same advisory lock as the interval (0054), so two near-simultaneous entries cannot both pass it.';

-- The foreign-key target that makes the partial unique index below possible.
-- allow_multiple_entries lives here and an index on participations cannot see
-- another table, so the flag is denormalised there and proved by this key.
alter table public.promotions
  add constraint promotions_id_multiple_unique unique (id, allow_multiple_entries);

-- Targets the answers table needs. Each exists so a child can prove a fact in
-- one constraint rather than by convention, the same reason 0041 carries
-- promotion_questions_id_kind_company_unique.
alter table public.promotion_questions
  add constraint promotion_questions_id_promotion_kind_company_unique
  unique (id, promotion_id, kind, company_id);

alter table public.promotion_question_options
  add constraint promotion_question_options_id_question_unique
  unique (id, question_id);

create table public.participations (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- Denormalised from the promotion, and not for convenience: the partial
  -- unique index below is the whole reason it exists, and the foreign key with
  -- ON UPDATE CASCADE is what stops it drifting from its source.
  allows_multiple boolean not null,

  status public.participation_status not null,
  source public.participation_source not null,

  -- When the person actually entered, which is not when the row was written.
  -- The minimum interval measures against this, so a historical import stamped
  -- "now" on every row would refuse its own second entry for a person and give
  -- a reason that is not true.
  participated_at timestamptz not null,

  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),

  -- No updated_at and no deleted_at. A participation is a thing that happened;
  -- it is not edited and it is not withdrawn, the same reasoning
  -- inventory_movements (0026) carries for the ledger.

  constraint participations_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),

  -- member_company_links is keyed on exactly this pair, so this one constraint
  -- proves the listener exists AND that this Station has them. A key to
  -- members (id, organization_id) would prove only the Organization, and an
  -- Organization with two Stations would let a participation name somebody this
  -- Station has never heard of.
  constraint participations_member_link_fk
    foreign key (member_id, company_id)
    references public.member_company_links (member_id, company_id),

  constraint participations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint participations_allows_multiple_fk
    foreign key (promotion_id, allows_multiple)
    references public.promotions (id, allow_multiple_entries)
    on update cascade
);

comment on table public.participations is
  'One row per attempt, including the refused ones. A refusal is recorded rather than thrown away because Block 5 will have no choice about it — a message arrived, and what happened to it has to be on the record — and building it now means Block 5 adds a source, not a column and a second write path.';

-- ON UPDATE CASCADE on the flag above is what earns this its keep: turning
-- "allows repeats" off on a promotion where one person already holds two valid
-- entries cascades the new value onto them and this index refuses the whole
-- update. The operator is stopped rather than left with a promotion whose stated
-- rule its own data breaks. Same shape as 0041's "a quiz with a right answer
-- cannot become a poll".
create unique index participations_one_per_member
  on public.participations (promotion_id, member_id)
  where status = 'VALID' and not allows_multiple;

-- The list orders by when somebody entered, newest first, tie-broken by id — a
-- keyset cursor must compare exactly what it orders by (Block 3b), so the index
-- carries both.
create index participations_listing_idx
  on public.participations (promotion_id, participated_at desc, id desc);

create index participations_member_idx
  on public.participations (member_id, participated_at desc);

-- The foreign-key target the answers need to prove they belong to the same
-- promotion as their participation.
alter table public.participations
  add constraint participations_id_promotion_unique unique (id, promotion_id);

create table public.participation_answers (
  id               uuid primary key default gen_random_uuid(),
  participation_id uuid not null,
  promotion_id     uuid not null,
  question_id      uuid not null,
  kind             public.promotion_question_kind not null,

  option_id   uuid,
  answer_text text,

  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  created_at      timestamptz not null default now(),

  -- Three keys, three different facts, none of them left to a check or to the
  -- RPC remembering. The answer belongs to a participation in this promotion;
  -- the question belongs to this promotion, has this kind and lives in this
  -- Station; the option belongs to this question.
  constraint participation_answers_participation_fk
    foreign key (participation_id, promotion_id)
    references public.participations (id, promotion_id),
  constraint participation_answers_question_fk
    foreign key (question_id, promotion_id, kind, company_id)
    references public.promotion_questions (id, promotion_id, kind, company_id),
  constraint participation_answers_option_fk
    foreign key (option_id, question_id)
    references public.promotion_question_options (id, question_id),

  constraint participation_answers_shape check (
    (kind = 'ESSAY'
       and option_id is null
       and answer_text is not null and length(btrim(answer_text)) > 0)
    or (kind in ('QUIZ', 'MULTIPLE_CHOICE')
       and option_id is not null and answer_text is null)
  ),

  constraint participation_answers_one_per_question
    unique (participation_id, question_id)
);

comment on table public.participation_answers is
  'What the person answered, not whether they were right. Block 6 derives correctness at draw time by joining promotion_question_options.is_correct; storing a flag here would be a second place telling the same truth, and Block 4a''s D9 freeze — no option may be reworded once somebody has chosen it — is what makes deriving it safe.';

create index participation_answers_participation_idx
  on public.participation_answers (participation_id);

alter table public.participations        enable row level security;
alter table public.participation_answers enable row level security;

-- A permission is born beside the feature it guards. Its own module rather than
-- more promotions.* codes, because participations get their own screen and every
-- screen-level module in this project owns its codes.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('participations.view',   'Read participations',              '4c', 'participations', 'See participations',       'company', 10),
  ('participations.create', 'Record a participation by hand',   '4c', 'participations', 'Record a participation',   'company', 20),
  ('participations.import', 'Import participations from a file','4c', 'participations', 'Import participations',    'company', 30);
