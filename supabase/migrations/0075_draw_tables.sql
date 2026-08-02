-- Block 6a, Task 1: the hat, the winners, and a deadline that cannot move.
--
-- Four tables. The boundary between this block and 6b is a row in winners:
-- 6a ends at the moment a winner exists, a prize has moved in the inventory and
-- a deadline is running. Handing the prize over is 6b.

create type public.draw_status as enum ('COMPLETED', 'CANCELLED');

comment on type public.draw_status is
  'Whether a draw stands or has been undone. There is no PENDING: a draw is one transaction, and a draw that did not finish did not happen.';

-- Created with the FULL set 6b will use, while this block writes only
-- AWAITING_PICKUP. Declaring them all now costs nothing and means 6b adds
-- behaviour rather than re-shaping a column other rows already hold.
create type public.winner_status as enum (
  'AWAITING_PICKUP', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'SUPERSEDED');

comment on type public.winner_status is
  'What happened to an awarded prize. Block 6a writes only AWAITING_PICKUP; DELIVERED, RETURNED, WRITTEN_OFF and SUPERSEDED are 6b''s vocabulary, declared here so 6b adds behaviour rather than re-shaping a column that already holds rows.';

-- The composite keys the child tables below need. Both are the same one-line
-- addition prizes (0025:77) and promotions (0040:177) already carry, and for
-- the same reason: the pair (id, company_id) unique on a parent is what lets a
-- child prove the Station in a single constraint rather than a trigger.
alter table public.participations
  add constraint participations_id_company_unique unique (id, company_id);

alter table public.promotion_prizes
  add constraint promotion_prizes_id_company_unique unique (id, company_id);

-- ---------------------------------------------------------------------------
-- draws: one row per draw of one promotion.

create table public.draws (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- 64 hex characters, generated inside run_draw and never an argument (D3):
  -- a seed a caller could choose is a seed a caller could shop for.
  seed              text not null check (seed ~ '^[0-9a-f]{64}$'),
  algorithm_version integer not null,
  runner_up_count   integer not null check (runner_up_count >= 0),
  entry_count       integer not null check (entry_count > 0),

  status      public.draw_status not null default 'COMPLETED',
  drawn_at    timestamptz not null default now(),
  drawn_by    uuid references auth.users (id),

  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id),
  cancellation_reason text,

  constraint draws_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint draws_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- The shape rule this schema uses everywhere: a cancellation is three facts
  -- or none of them. Without it a row can claim it was cancelled and not say
  -- by whom or why, which is the one thing a cancelled draw has to say.
  constraint draws_cancellation_shape check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null
        and length(btrim(coalesce(cancellation_reason, ''))) > 0)
  ),
  constraint draws_cancelled_status check (
    (status = 'CANCELLED') = (cancelled_at is not null)
  ),
  constraint draws_id_company_unique unique (id, company_id)
);

create index draws_promotion_idx on public.draws (promotion_id, drawn_at desc);

comment on table public.draws is
  'One draw of one promotion. The seed, the algorithm version and the frozen hat in draw_entries are together the whole record: anybody holding them can recompute the winners and get the same names.';
comment on column public.draws.seed is
  'Two gen_random_uuid() values with their hyphens stripped: 64 hex characters, 244 bits, CSPRNG-backed and needing no extension. Generated INSIDE run_draw and never an argument, because a seed a caller could choose is a seed a caller could shop for (D3).';
comment on column public.draws.algorithm_version is
  'Which version of the contract in the design spec 4.1 produced this draw. Per draw rather than global, so changing the algorithm later does not invalidate draws already run -- it only means old draws are verified with the old rule.';
comment on column public.draws.entry_count is
  'How many entries were in the hat, denormalised so a report does not have to count. Always > 0: a promotion with nobody eligible is refused rather than recorded as an empty draw (spec 7).';

-- ---------------------------------------------------------------------------
-- draw_entries: the hat, frozen.
--
-- This table is the reason the draw is verifiable. Participations keep arriving
-- after the draw; without a frozen list, a reproduction run tomorrow would use
-- a different hat and disagree for a reason that has nothing to do with the
-- algorithm.

create table public.draw_entries (
  draw_id          uuid not null,
  company_id       uuid not null,
  participation_id uuid not null,
  member_id        uuid not null,
  position         integer not null check (position > 0),

  primary key (draw_id, position),
  constraint draw_entries_participation_unique unique (draw_id, participation_id),

  constraint draw_entries_draw_fk
    foreign key (draw_id, company_id)
    references public.draws (id, company_id),
  constraint draw_entries_participation_fk
    foreign key (participation_id, company_id)
    references public.participations (id, company_id),
  -- Keyed on the link, not on members (id, organization_id), for the reason
  -- participations_member_link_fk (0052) gives: this one constraint proves the
  -- listener exists AND that this Station has them.
  constraint draw_entries_member_link_fk
    foreign key (member_id, company_id)
    references public.member_company_links (member_id, company_id)
);

create index draw_entries_member_idx on public.draw_entries (member_id);

comment on table public.draw_entries is
  'The hat at the instant of the draw: one row per eligible participation, numbered from 1 in (participated_at, id) order. An excluded participation is NOT recorded here -- the hat is what was drawn from, and a row that could never have been picked would make the reproduction disagree.';
comment on column public.draw_entries.position is
  '1..N in the frozen order. Also the tie-break when two entries hash to the same ranking value (spec 4.1 step 4) -- astronomically unlikely, and defined anyway, because "unlikely" is not a rule a reproduction can follow.';

-- ---------------------------------------------------------------------------
-- winners.

create table public.winners (
  id                 uuid primary key default gen_random_uuid(),
  draw_id            uuid not null,
  company_id         uuid not null,
  promotion_prize_id uuid not null,
  member_id          uuid not null,
  participation_id   uuid not null,
  awarded_rank       integer not null check (awarded_rank > 0),

  deadline_at timestamptz,
  status      public.winner_status not null default 'AWAITING_PICKUP',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint winners_rank_unique unique (draw_id, awarded_rank),

  -- D2 made structural. One person wins at most one prize per draw is the
  -- owner's rule; it falls out of the walk in run_draw, and it is ALSO here so
  -- that a future edit to the walk cannot quietly break it.
  constraint winners_one_prize_per_member unique (draw_id, member_id),

  constraint winners_draw_fk
    foreign key (draw_id, company_id)
    references public.draws (id, company_id),
  constraint winners_promotion_prize_fk
    foreign key (promotion_prize_id, company_id)
    references public.promotion_prizes (id, company_id),
  constraint winners_participation_fk
    foreign key (participation_id, company_id)
    references public.participations (id, company_id),
  constraint winners_member_link_fk
    foreign key (member_id, company_id)
    references public.member_company_links (member_id, company_id)
);

create index winners_draw_idx on public.winners (draw_id, awarded_rank);
create index winners_deadline_idx on public.winners (deadline_at)
  where status = 'AWAITING_PICKUP' and deadline_at is not null;

comment on table public.winners is
  'One row per awarded unit. promotion_prize_id names WHICH link was consumed, which is the chain the master spec requires and how 6b''s delivery decrements the right promotion''s counter.';
comment on column public.winners.awarded_rank is
  'The unit''s position in the ordered unit sequence of its draw (spec 4.1 step 5), so a reproduction consumes the units in the same order it did.';
comment on column public.winners.deadline_at is
  'Frozen at the draw (D5). Null means this winner has NO deadline, because neither the promotion nor the prize set one -- 6b''s cron skips a null rather than inventing a rule the Station never agreed to.';

-- ---------------------------------------------------------------------------
-- draw_runners_up: the queue 6b walks.
--
-- ONE queue for the draw, not one per prize (D4). With one-prize-per-person in
-- force, per-prize queues would cross and the same listener would sit in
-- several of them.

create table public.draw_runners_up (
  draw_id          uuid not null,
  company_id       uuid not null,
  position         integer not null check (position > 0),
  member_id        uuid not null,
  participation_id uuid not null,

  primary key (draw_id, position),
  constraint draw_runners_up_member_unique unique (draw_id, member_id),

  constraint draw_runners_up_draw_fk
    foreign key (draw_id, company_id)
    references public.draws (id, company_id),
  constraint draw_runners_up_participation_fk
    foreign key (participation_id, company_id)
    references public.participations (id, company_id),
  constraint draw_runners_up_member_link_fk
    foreign key (member_id, company_id)
    references public.member_company_links (member_id, company_id)
);

comment on table public.draw_runners_up is
  'The runner-up queue, in order, for the whole draw. Drawn in the same pass from the same hat under the same one-prize-per-person rule (D4).';

-- ---------------------------------------------------------------------------
-- The deadline, in days, at both levels (spec 6).

alter table public.prizes
  add column default_pickup_deadline_days integer
    check (default_pickup_deadline_days is null or default_pickup_deadline_days > 0);

alter table public.promotions
  add column pickup_deadline_days integer
    check (pickup_deadline_days is null or pickup_deadline_days > 0);

comment on column public.prizes.default_pickup_deadline_days is
  'How many days a winner has to collect this prize, unless the promotion overrides it. Null means NO deadline: a Station that has not configured one has not agreed to a rule, and inventing thirty days for them would start a clock they never set.';
comment on column public.promotions.pickup_deadline_days is
  'Overrides prizes.default_pickup_deadline_days for winners of this promotion. Read once, at the draw, into winners.deadline_at -- editing it in September must not shorten the deadline of somebody who won in August (D5).';

-- ---------------------------------------------------------------------------
-- RLS and the grants.
--
-- Reading a draw is reading a promotion, so all four read under
-- promotions.view. Every write goes through run_draw and cancel_draw, which are
-- SECURITY DEFINER and check their own permission beside their own operation --
-- there is no insert or update policy here because no caller may write these
-- tables directly.

alter table public.draws            enable row level security;
alter table public.draw_entries     enable row level security;
alter table public.winners          enable row level security;
alter table public.draw_runners_up  enable row level security;

create policy draws_select_by_promotion_view
  on public.draws for select to authenticated
  using (public.has_permission('promotions.view', company_id));

create policy draw_entries_select_by_promotion_view
  on public.draw_entries for select to authenticated
  using (public.has_permission('promotions.view', company_id));

create policy winners_select_by_promotion_view
  on public.winners for select to authenticated
  using (public.has_permission('promotions.view', company_id));

create policy draw_runners_up_select_by_promotion_view
  on public.draw_runners_up for select to authenticated
  using (public.has_permission('promotions.view', company_id));

-- This schema revokes Supabase's default ACL and grants back by hand. Block 5a
-- shipped three tables with the comment and without the grant and was
-- non-functional end to end; Task 8 drives each of these across the real HTTP
-- boundary for the same reason.
revoke all on public.draws           from anon, authenticated;
revoke all on public.draw_entries    from anon, authenticated;
revoke all on public.winners         from anon, authenticated;
revoke all on public.draw_runners_up from anon, authenticated;

revoke truncate on public.draws           from service_role;
revoke truncate on public.draw_entries    from service_role;
revoke truncate on public.winners         from service_role;
revoke truncate on public.draw_runners_up from service_role;

grant select on public.draws           to authenticated;
grant select on public.draw_entries    to authenticated;
grant select on public.winners         to authenticated;
grant select on public.draw_runners_up to authenticated;

grant select, insert on public.draws           to service_role;
grant select, insert on public.draw_entries    to service_role;
grant select, insert on public.winners         to service_role;
grant select, insert on public.draw_runners_up to service_role;

-- ---------------------------------------------------------------------------
-- The permissions. Two codes, not one (spec 4.3), separate for the reason
-- promotions.prizes is separate from promotions.edit (0049): cancelling a draw
-- un-awards prizes somebody has already been told they won, and whoever may run
-- a draw is not thereby somebody who may undo one.

insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('draws.execute', 'Run a promotion''s draw',              '6a', 'promotions', 'Run a draw',    'company', 70),
  ('draws.cancel',  'Cancel a draw that has already run',   '6a', 'promotions', 'Cancel a draw', 'company', 80);
