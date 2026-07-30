-- supabase/migrations/0041_promotion_questions.sql

create table public.promotion_questions (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  position     integer not null check (position > 0),
  kind         public.promotion_question_kind not null,
  prompt       text not null check (length(btrim(prompt)) > 0),

  -- The two fields of a WhatsApp interactive list message. They are what the
  -- owner's screen calls Título do Menu and Título do Botão.
  menu_title   text,
  button_label text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint promotion_questions_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),

  constraint promotion_questions_list_fields check (
    (kind = 'ESSAY' and menu_title is null and button_label is null)
    or (kind in ('QUIZ', 'MULTIPLE_CHOICE')
        and menu_title is not null and length(btrim(menu_title)) > 0
        and button_label is not null and length(btrim(button_label)) > 0)
  ),

  -- Plain, not deferrable, because 4a has no reordering: questions are appended
  -- and asked in position order, which is what the owner's screen does today.
  -- Adding reordering later means making this deferrable at that point, so that
  -- a swap inside one transaction does not collide with itself midway.
  constraint promotion_questions_position_unique unique (promotion_id, position),

  -- Exists so the options table can prove kind AND Station in one foreign key.
  constraint promotion_questions_id_kind_company_unique unique (id, kind, company_id)
);

comment on table public.promotion_questions is
  'Carries no deleted_at on purpose. Soft deletion exists to keep rows that something still points at; a question may only be removed while the promotion has no participation (4c), so nothing can be pointing at one when it goes.';

create index promotion_questions_promotion_idx
  on public.promotion_questions (promotion_id, position);

alter table public.promotion_questions enable row level security;

create table public.promotion_question_options (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null,
  kind            public.promotion_question_kind not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  position   integer not null check (position > 0),
  label      text not null check (length(btrim(label)) > 0),
  is_correct boolean not null default false,

  created_at timestamptz not null default now(),

  -- kind is denormalised here so that two rules become structural rather than
  -- prose. ON UPDATE CASCADE earns its keep on the edit path: changing a
  -- question from QUIZ to MULTIPLE_CHOICE cascades the new kind onto its
  -- options, where the is_correct check below then refuses the whole update
  -- while any option is still marked right — so a quiz cannot quietly become a
  -- poll while keeping a right answer.
  constraint promotion_question_options_question_fk
    foreign key (question_id, kind, company_id)
    references public.promotion_questions (id, kind, company_id)
    on update cascade,

  constraint promotion_question_options_not_essay check (kind <> 'ESSAY'),

  constraint promotion_question_options_correct_only_on_quiz check (
    kind = 'QUIZ' or is_correct = false
  ),

  constraint promotion_question_options_position_unique unique (question_id, position)
);

-- At most one right answer. No index can require a FIRST one — that rule lives
-- in save_promotion_question (0043) and is weaker for it, which the design spec
-- says out loud rather than leaving to be discovered.
create unique index promotion_question_options_one_correct
  on public.promotion_question_options (question_id)
  where is_correct;

create index promotion_question_options_question_idx
  on public.promotion_question_options (question_id, position);

alter table public.promotion_question_options enable row level security;
