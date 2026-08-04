# Block 7b — The Requests and the First Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what listeners asked for, and give this codebase its first merge — one private core, five public doors — so a duplicated song, artist, label, genre or show can be collapsed without losing its history.

**Architecture:** The database keeps every boundary. `music_merges` is the history table §3.4 names; `apply_music_merge` is a private `SECURITY INVOKER` core in the shape of `apply_winner_transition` (0092), and five `SECURITY DEFINER` doors check `music.merge` before revealing whether anything exists (0093's rule). `list_music_requests` is `SECURITY DEFINER` and restates by hand the three rules RLS would otherwise apply (D6), exactly as `list_participations` (0090) and `list_pickups` (0095) already do. Two screens sit on top: Requests (list, filters, manual entry) and Maintenance (filter, tick, stage, name the survivor, merge).

**Tech Stack:** Postgres 15 / Supabase, plpgsql, pgTAP, Next.js 15 App Router (Server Components + Server Actions), TypeScript strict + `noUncheckedIndexedAccess`, Zod, Vitest, Playwright.

---

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-08-03-block-7-music-design.md`) and from the house rules every earlier block established. **Every task's requirements implicitly include this section.**

- **Migrations are append-only across merges.** The next free number is `0105`. Within this unmerged branch a migration may be edited in place (0045's own comment states the rule); once merged, never.
- **Everything user-visible is in English.** Code, comments, commit messages, docs, and every string on an operator screen. (Listener-facing WhatsApp copy stays Portuguese — none of it is in this block.)
- **This project deletes nothing.** Every removal is `deleted_at = now()`. The merge soft-deletes its losers and never issues a `delete`.
- **Permission before existence.** Every door checks `has_permission` before it reveals whether an id names anything — an unknown id and an unauthorised Station answer `42501` alike (0093).
- **A `SECURITY DEFINER` function inherits no RLS.** Every rule the policy would have applied has to be restated in the body, by hand. This is the rule Block 6c lost for five commits.
- **`revoke execute … from public` on every function**, then `grant execute … to authenticated` on the public ones only. The private core gets the revoke and no grant.
- **`set search_path = pg_catalog, public`** on every function.
- **No write grant to `service_role`** on any music table, and `revoke truncate` where a new table is created (0099's own lesson, from 0029).
- **pgTAP runs as superuser and `has_permission` answers false there, not true** — `auth.uid()` is null. Every pgTAP test of a gated RPC needs the actor fixture: `roles` + `role_permissions` + `auth.users` + `company_memberships`, then `set local role authenticated` with the JWT claims around the call and `reset role` before any read RLS would hide. The pattern is in `supabase/tests/15_music_rpcs.test.sql`.
- **Isolation-suite labels must be stamped.** Every new identity label carries `${Date.now()}` (or the file's single `STAMP`), because `cleanupUsers` can fail to delete a user referenced by an audited RPC and an unstamped label only collides on the *second* run.
- **A new isolation file needs an entry in `REQUIRED_TEST_FILES`** (`scripts/verify-isolation-suite.mjs`) with a `minTests` floor, or cases can be deleted with nothing unbalancing.
- **Gates:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run db:test`. `test:isolation` and `test:e2e` carry pre-existing environment failures (`docs/block-7a-report.md` §1.1–1.2) — run them, report what they say, and never declare them green by assumption.

---

## Two amendments to the spec this plan carries

**1. There are FIVE merge doors, not four.** The spec's D3 gave songs, artists, record labels and genres a merge and deliberately left `shows` without one, recording it as the owner's call at 7b. **The owner ruled on 2026-08-04: include `merge_shows`.** A duplicated show splits Block 8's per-programme numbers exactly as a duplicated song splits "most requested", and `shows` had no other cure — D2 removed every unique index and archiving leaves the requests pointing at an archived row.

Three places in the shipped codebase predict the opposite and must be corrected by this block, or they become lies a future reader trusts:

| file | what it says today |
|---|---|
| `supabase/migrations/0098_music_catalogue.sql` | `comment on table public.shows` — "The one catalogue entity with no cure for a duplicate… whether it is wanted is the owner's call." |
| `supabase/migrations/0100_music_reference_rpcs.sql` | the `NOTE FOR 7b` header and `music_reference_kind`'s comment — "that set drops SHOW and adds SONG" |
| `src/schemas/music.ts` | `MUSIC_REFERENCE_KINDS`' doc line — "NOT 7b's merge kinds, which drop SHOW and add SONG" |

Migrations are append-only, so 0098's and 0100's comments are **re-issued** with `comment on …` statements in Task 1 rather than edited. The TypeScript line is edited in place.

**2. `create_music_request` does not take a channel.** The spec's §3.3 gives `music_requests.channel` the values `MANUAL | IMPORT`. The manual door writes `MANUAL` and offers no parameter, so a caller cannot label a hand-typed row as an import. Block 9's ETL gets its own door, the way `import_participations` is separate from `record_participation` (0054). `record_participation` does take `p_source`, and 0054's comment calls it "recorded, not consulted" — that is a wider door than this block needs, and 0101's own warning about "a parameter that looks like it decides something while deciding nothing" points the other way.

---

## Three decisions this plan makes that the spec did not

**D-a — The core takes the Station as an argument, and scopes its lock to it.** `apply_music_merge(p_kind, p_company_id, p_winner_id, p_loser_ids, p_reason)`. The door resolves the Station from the *winner* row under `has_permission` (0093's one-gated-query idiom) and hands it down; the core then locks winner and losers with `where id = any(...) and company_id = p_company_id`.

This is what makes §4's "refuses records belonging to different Stations" enforced *by construction* rather than by a comparison. A comparison would be an oracle: a caller holding `music.merge` in Station A could probe whether a uuid names a live song in Station B by reading which of two error messages came back. Scoped this way, a loser in another Station is simply not found, and answers the identical `P0002` as a uuid that names nothing at all.

**D-b — Winner and losers are locked in ONE pass, ordered by id.** Not the winner first and the losers after. Two operators merging overlapping sets in opposite directions — A says "W wins, L loses", B says "L wins, W loses" — would deadlock under winner-first ordering. One `order by id … for update` pass makes them queue instead. The `LockRows` node sits above the `Sort`, so the rows really are locked in sorted order.

**D-c — The repoint moves withdrawn children too, and the count says how many moved.** `music_merges.children_moved` is one column beyond the six §3.4 lists (winner, loser, kind, reason, actor, when). It is there because D3's entire failure mode is a merge that forgets its `update`: §6 asks the test to count children before and after, and this column asks the same question in production, six months later, where no test is running.

Soft-deleted children move with the live ones. A withdrawn request still points somewhere, and leaving it pointing at a row the merge just archived would mean the same uuid means two different things depending on which side of `deleted_at` you read.

---

## File Structure

**Created**

| path | responsibility |
|---|---|
| `supabase/migrations/0105_music_merges.sql` | `music_merge_kind`, `music_merge_table()`, the `music_merges` table, its RLS, and the three corrected comments |
| `supabase/migrations/0106_music_merge_doors.sql` | the private `apply_music_merge` core and the five public doors |
| `supabase/migrations/0107_music_requests_rpcs.sql` | `create_music_request`, `archive_music_request`, `list_music_requests` |
| `supabase/migrations/0108_list_merge_candidates.sql` | the Maintenance screen's one read |
| `supabase/tests/16_music_merge.test.sql` | pgTAP: the merge's mechanics, the history row, the atomicity |
| `supabase/tests/17_music_requests.test.sql` | pgTAP: the request doors and `list_music_requests`' three rules |
| `tests/isolation/music-merge.test.ts` | the tenant boundary and the D6 identity rules, with real JWTs |
| `src/app/(app)/music/requests/page.tsx` | the Requests screen |
| `src/app/(app)/music/requests/list-params.ts` | its URL contract |
| `src/app/(app)/music/requests/requests-filters.tsx` | song / show / channel filters and the listener search |
| `src/app/(app)/music/requests/requests-grid.tsx` | the rows |
| `src/app/(app)/music/requests/record-request-form.tsx` | manual entry: listener picker, song picker, show, date |
| `src/app/(app)/music/requests/actions.ts` | its two Server Actions |
| `src/app/(app)/music/maintenance/page.tsx` | the Maintenance screen |
| `src/app/(app)/music/maintenance/list-params.ts` | its URL contract (kind + search) |
| `src/app/(app)/music/maintenance/merge-panel.tsx` | tick, stage, name the survivor, reason, merge |
| `src/app/(app)/music/maintenance/actions.ts` | its one Server Action |
| `tests/unit/music-merge-schema.test.ts` | the merge and request schemas |
| `tests/e2e/music-requests.spec.ts` | the round trip: record a request, then merge its song away and find it under the survivor |
| `docs/block-7b-report.md`, `docs/block-7b-runbook.md` | the verification report and the deploy runbook |

**Modified**

| path | change |
|---|---|
| `src/schemas/music.ts` | merge + request schemas; correct the stale `MUSIC_REFERENCE_KINDS` note |
| `src/services/music.ts` | the request reads/writes, the merge doors, `searchSongs`, `listMergeCandidates`, and `mapMusicError`'s two new codes |
| `src/app/(app)/music/errors.ts` | a merge-refusal sentence |
| `src/app/(app)/music/permissions.ts` | nothing — it already reports `request` and `merge` |
| `src/lib/auth/shell.ts` | two nav items under Music |
| `src/lib/supabase/database.types.ts` | regenerated |
| `scripts/verify-isolation-suite.mjs` | the new file's `REQUIRED_TEST_FILES` entry |

---

## Task 1: `music_merges`, the kind, and the three comments that predicted four doors

**Files:**
- Create: `supabase/migrations/0105_music_merges.sql`
- Create: `supabase/tests/16_music_merge.test.sql` (the table half; the function half arrives in Task 2)
- Modify: `src/schemas/music.ts:9-11`

**Interfaces:**
- Produces: type `public.music_merge_kind` = `'SONG' | 'ARTIST' | 'LABEL' | 'GENRE' | 'SHOW'`; function `public.music_merge_table(public.music_merge_kind) returns text`; table `public.music_merges (id, organization_id, company_id, kind, winner_id, loser_id, reason, children_moved, merged_by, created_at)`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/16_music_merge.test.sql`. Fixtures live in the `…00e2xx` range — `14_music_catalogue` owns `…00e0xx` and `15_music_rpcs` owns `…00e1xx`.

```sql
begin;
select plan(9);

-- Block 7b, Task 1: the history table, and the kind that drives all five
-- doors. The doors themselves are Task 2; this file grows to cover them.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e2f1', 'Org 7b merge');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2f1',
   'Station 7b merge', 'America/Sao_Paulo');

-- 1: five kinds, and the order is pinned. SHOW is present because the owner
-- ruled for merge_shows on 2026-08-04, against D3's original four — the two
-- comments 0098 and 0100 carry to the contrary are re-issued below.
select is(
  enum_range(null::public.music_merge_kind)::text[],
  array['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'],
  'music_merge_kind is the five mergeable entities — shows included');

-- 2-6: the kind resolves to a table, totally. A kind added to the enum without
-- a branch here returns null, and every caller formats that into public."" and
-- fails loudly rather than writing somewhere unintended.
select is(public.music_merge_table('SONG'),   'songs',         'SONG maps to songs');
select is(public.music_merge_table('ARTIST'), 'artists',       'ARTIST maps to artists');
select is(public.music_merge_table('LABEL'),  'record_labels', 'LABEL maps to record_labels');
select is(public.music_merge_table('GENRE'),  'music_genres',  'GENRE maps to music_genres');
select is(public.music_merge_table('SHOW'),   'shows',         'SHOW maps to shows');

-- 7: a merge without a reason is not a merge. The column refuses blank as well
-- as null, because '   ' would satisfy NOT NULL and answer nothing in six
-- months' time.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  values ('00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
          'SONG', gen_random_uuid(), gen_random_uuid(), '   ', 0)
$$, '23514', null, 'a blank reason is refused by the check constraint');

-- 8: the winner cannot be the loser, at the column level as well as in the
-- core — a history row saying a record absorbed itself would be unreadable.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  select '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
         'SONG', id, id, 'same', 0
    from (select gen_random_uuid() as id) s
$$, '23514', null, 'a row where the winner is also the loser is refused');

-- 9: authenticated may read the history and may not write it. The only writer
-- is the SECURITY DEFINER core.
select ok(
  not has_table_privilege('authenticated', 'public.music_merges', 'INSERT'),
  'authenticated cannot insert a merge history row directly');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `type "public.music_merge_kind" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0105_music_merges.sql`:

```sql
-- supabase/migrations/0105_music_merges.sql

-- Block 7b, Task 1: the record of what was merged into what.
--
-- §3.4 of the design spec: who won, who left, of what kind, the reason
-- (mandatory), the actor and when. It is what answers, six months later, why a
-- song vanished from the catalogue — without it a merge is indistinguishable
-- from somebody having deleted the wrong record.

-- FIVE kinds, not the four D3 named. The owner ruled on 2026-08-04 that shows
-- merge too: a duplicated programme splits Block 8's per-show numbers exactly
-- as a duplicated song splits "most requested", and shows had no other cure —
-- D2 removed every unique index, and archiving one leaves its requests
-- pointing at a row 0099's policy makes unreadable.
--
-- This is NOT music_reference_kind (0100). That enum is the four short lists
-- that are a name and nothing else; this one drops nothing and adds SONG.
create type public.music_merge_kind as enum ('SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW');

comment on type public.music_merge_kind is
  'The five entities a merge can collapse. Distinct from music_reference_kind (0100), which is the four short lists: this set adds SONG and keeps SHOW, after the owner ruled for merge_shows on 2026-08-04.';

-- The one place a kind becomes a table name. IMMUTABLE and total, in the shape
-- of music_reference_table (0100): a value added to the enum without a branch
-- here returns null, and every caller formats that null into `public.""` and
-- fails loudly rather than writing somewhere unintended.
create function public.music_merge_table(p_kind public.music_merge_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'SONG'   then 'songs'
    when 'ARTIST' then 'artists'
    when 'LABEL'  then 'record_labels'
    when 'GENRE'  then 'music_genres'
    when 'SHOW'   then 'shows'
  end;
$$;

revoke execute on function public.music_merge_table(public.music_merge_kind) from public;

comment on function public.music_merge_table(public.music_merge_kind) is
  'Maps a merge kind to its table name, for the format(%I) in 0106''s core. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

create table public.music_merges (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  kind            public.music_merge_kind not null,
  -- No foreign key on either id, and this is the cost of one history table
  -- rather than five: the pair points at whichever of the five tables `kind`
  -- names, and Postgres has no way to express that. The core resolves both
  -- through music_merge_table and locks them before writing, so nothing
  -- unverified reaches these columns — but a reader must not mistake the
  -- absence of an FK for an oversight.
  winner_id       uuid not null,
  loser_id        uuid not null,
  reason          text not null,
  -- Beyond §3.4's six. D3's whole failure mode is a merge that forgets its
  -- update: §6 asks the TEST to count children before and after, and this
  -- column asks the same question in production, months later, where no test
  -- is running. Zero is a legitimate value — a duplicate nobody had used yet.
  children_moved  integer not null,
  merged_by       uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  constraint music_merges_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- Blank as well as null. '   ' satisfies NOT NULL and answers nothing in six
  -- months, which is the entire purpose of the column.
  constraint music_merges_reason_not_blank check (btrim(reason) <> ''),
  constraint music_merges_winner_is_not_loser check (winner_id <> loser_id),
  constraint music_merges_children_not_negative check (children_moved >= 0)
);

comment on table public.music_merges is
  'One row per absorbed record: who won, who left, of what kind, why, by whom and when, plus how many children the merge repointed. Written only by apply_music_merge (0106), which is SECURITY INVOKER and granted to nobody — there is no other way to add a row, and no way at all to remove one. This is the first merge history in this codebase; the listener merge ruled for on 2026-08-01 should reuse the same shape.';

create index music_merges_company_created_idx on public.music_merges (company_id, created_at desc);
-- "Where did this record go?" is asked of the LOSER, which is the id that
-- stopped appearing in every list.
create index music_merges_loser_idx  on public.music_merges (loser_id);
create index music_merges_winner_idx on public.music_merges (winner_id);

-- ---------------------------------------------------------------------------
-- RLS. Read-only for everybody; the core writes as the table owner.
-- ---------------------------------------------------------------------------

alter table public.music_merges enable row level security;

revoke all on public.music_merges from anon, authenticated;

grant select on public.music_merges to authenticated;

-- music.view, not music.merge: the history explains a hole in a list, and
-- everybody who can read the list needs to be able to read the explanation.
-- Holding the power to merge is a different question from being allowed to
-- learn that one happened.
--
-- No `deleted_at is null` clause, because there is no deleted_at: a history
-- row is never removed. That is deliberate and not an omission of the
-- convention 0099 follows for the six domain tables.
create policy music_merges_select_music_view on public.music_merges
  for select to authenticated
  using (public.has_permission('music.view', company_id));

-- service_role needs the explicit grant (Block 1a §3.9: BYPASSRLS does not
-- substitute for a GRANT), and read-only for the reason 0099 gives.
--
-- No write grant is needed to make the merge work, and this is worth saying
-- precisely because the chain is two links long: the five DOORS in 0106 are
-- SECURITY DEFINER, so they run as this table's owner, and the private core
-- they call is SECURITY INVOKER — which inherits the doors' current_user
-- rather than the caller's. That is the same shape apply_winner_transition
-- (0092) already uses to write winner_status_history, a table `authenticated`
-- holds only SELECT on (0081). So the only writer here is already the owner,
-- and granting service_role INSERT would add a second, unaudited way to
-- rewrite a Station's merge history rather than enable anything.
grant select on public.music_merges to service_role;

-- The default ACL leaves service_role holding TRUNCATE, which `revoke all`
-- above never touched (it named anon and authenticated only). One statement
-- would erase every explanation of every merge. 0029 closed this on the
-- inventory ledger and 0099 on the six music tables; closed here before
-- anybody has to find it a fourth time.
revoke truncate on public.music_merges from service_role;

-- ---------------------------------------------------------------------------
-- Three comments that predicted four doors, re-issued to say five.
--
-- Migrations are append-only, so 0098's and 0100's text cannot be edited —
-- and a comment that contradicts the schema is worse than no comment, because
-- a reader trusts it. src/schemas/music.ts carries the third and is edited in
-- place, being ordinary source.
-- ---------------------------------------------------------------------------

comment on table public.shows is
  'A Station''s programmes. Merged like the other four (0106''s merge_shows), after the owner ruled on 2026-08-04 against D3''s original set of four — 0098''s own comment recorded that gap as the owner''s call at 7b, and this is the call. Still deliberately carries no unique index on the name: D2 allows the duplicate and the merge is the cure.';

comment on type public.music_reference_kind is
  'The four catalogue lists that are a name and nothing else. Not the merge''s kinds (music_merge_kind, 0105) — that set adds SONG and, since the owner''s 2026-08-04 ruling, keeps SHOW. 0100''s own header predicted it would drop SHOW; it does not.';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:test`
Expected: PASS, 9 new assertions.

- [ ] **Step 5: Correct the stale note in the schema module**

In `src/schemas/music.ts`, replace the doc line on `MUSIC_REFERENCE_KINDS` (line 9):

```ts
/**
 * The four short lists 0100's music_reference_kind carries. Not the merge's
 * kinds (MUSIC_MERGE_KINDS below): that set adds SONG and keeps SHOW, after
 * the owner ruled for merge_shows on 2026-08-04. This line used to say the
 * merge would drop SHOW, which 0105 corrects at the database as well.
 */
```

- [ ] **Step 6: Regenerate the database types**

Run: `npm run db:types` (or the project's documented equivalent — check `package.json`), then `npm run typecheck`.
Expected: `music_merges` and `music_merge_kind` appear in `src/lib/supabase/database.types.ts`; typecheck green.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0105_music_merges.sql supabase/tests/16_music_merge.test.sql src/schemas/music.ts src/lib/supabase/database.types.ts
git commit -m "feat(music): the merge history, and the fifth kind the owner asked for"
```

---

## Task 2: One private core, five public doors

**Files:**
- Create: `supabase/migrations/0106_music_merge_doors.sql`
- Modify: `supabase/tests/16_music_merge.test.sql` (raise `plan(9)` to `plan(28)`)

**Interfaces:**
- Consumes: `public.music_merge_kind`, `public.music_merge_table()`, `public.music_merges` (Task 1).
- Produces: `public.apply_music_merge(p_kind public.music_merge_kind, p_company_id uuid, p_winner_id uuid, p_loser_ids uuid[], p_reason text) returns integer` — **private**. Five doors, each `(p_winner_id uuid, p_loser_ids uuid[], p_reason text) returns integer`: `merge_songs`, `merge_artists`, `merge_record_labels`, `merge_music_genres`, `merge_shows`. The integer is the total number of children repointed.

- [ ] **Step 1: Write the failing pgTAP tests**

Append to `supabase/tests/16_music_merge.test.sql`, before `select * from finish();`, and change `plan(9)` to `plan(28)`.

```sql
-- ---------------------------------------------------------------------------
-- The doors. An actor fixture, because has_permission reads auth.uid() and
-- pgTAP's superuser connection has none — calling these as postgres would
-- prove nothing about the gate and would also bypass every EXECUTE grant, so
-- a missing `grant execute … to authenticated` would still pass.
--
-- BOTH music.view and music.merge: merge alone passes the doors but leaves
-- the actor unable to read a single row back, since 0099's select policies
-- gate on music.view.
-- ---------------------------------------------------------------------------

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e2a1', '00000000-0000-0000-0000-00000000e2f1',
   'Music merger 7b');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e2a1', 'music.view'),
  ('00000000-0000-0000-0000-00000000e2a1', 'music.merge');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e2a2', 'music-merger-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e2a2', '00000000-0000-0000-0000-00000000e2c1',
   '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2a1');

-- Two artists, a song under each, a listener, and a request against each song.
-- Written as the superuser: authenticated holds no INSERT on any of these.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2b1', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Caetano Veloso'),
  ('00000000-0000-0000-0000-00000000e2b2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Caetano Velloso');

insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e2d1', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Sozinho', '00000000-0000-0000-0000-00000000e2b1'),
  ('00000000-0000-0000-0000-00000000e2d2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Sozinho', '00000000-0000-0000-0000-00000000e2b2');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000e2e1', '00000000-0000-0000-0000-00000000e2f1', 'Ana Listener');

insert into public.music_requests (id, organization_id, company_id, member_id, song_id) values
  ('00000000-0000-0000-0000-00000000e2e2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2e1',
   '00000000-0000-0000-0000-00000000e2d2'),
  -- A WITHDRAWN request against the same loser. It must move too: leaving it
  -- pointing at a row the merge just archived would make one uuid mean two
  -- different things depending on which side of deleted_at you read.
  ('00000000-0000-0000-0000-00000000e2e3', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2e1',
   '00000000-0000-0000-0000-00000000e2d2');
update public.music_requests set deleted_at = now()
 where id = '00000000-0000-0000-0000-00000000e2e3';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 10: the private core is not reachable from outside, whatever else is true.
select ok(
  not has_function_privilege('authenticated',
    'public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text)', 'EXECUTE'),
  'apply_music_merge is granted to nobody');

-- 11: a merge needs a reason.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], '  ')
$$, '22023', null, 'a merge without a reason is refused');

-- 12: a merge needs somebody to absorb.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array[]::uuid[], 'nothing to do')
$$, '22023', null, 'a merge naming no losers is refused');

-- 13: the survivor cannot also be absorbed.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d1']::uuid[], 'itself')
$$, '22023', null, 'a merge that names the winner among the losers is refused');

-- 14: THE ATOMICITY PROOF. Two losers, one of which does not exist. NEITHER
-- may move — proved by counting the requests on the winner afterwards, not by
-- reading the function.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2',
          '00000000-0000-0000-0000-0000000000ff']::uuid[], 'one is bogus')
$$, 'P0002', null, 'a merge naming a record that is not there is refused whole');

reset role;

-- 15: and the good loser really did not move.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d1'),
  0, 'the refused merge moved nothing at all');

-- 16: the loser is still alive after the refusal.
select is(
  (select deleted_at from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  null, 'the refused merge archived nothing');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 17: the real merge, and it reports what it moved. TWO, not one: the
-- withdrawn request moves with the live one.
select is(
  public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], 'same recording, typed twice'),
  2, 'merge_songs repoints both requests and says so');

reset role;

-- 18: THE PROOF THAT MATTERS — the children actually moved. A test asserting
-- only the loser's deleted_at passes over a function that forgot its update,
-- and the operator finds out from Block 8's dashboard.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d1'),
  2, 'both requests now point at the surviving song');

-- 19: nothing still points at the loser.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d2'),
  0, 'nothing is left pointing at the absorbed song');

-- 20-21: the loser left the lists, and its history survived. Two assertions,
-- not one — §6 asks for both.
select isnt(
  (select deleted_at from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  null, 'the absorbed song is archived');
select ok(
  exists(select 1 from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  'the absorbed song is still a row — this project deletes nothing');

-- 22-24: the history row says who, why and how many.
select is(
  (select count(*)::int from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  1, 'one history row per absorbed record');
select is(
  (select reason from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  'same recording, typed twice', 'the reason is kept verbatim');
select is(
  (select children_moved from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  2, 'the history row records how many children moved');

-- 25: the audit log has the merge, once for the operation.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'merge_music' and target_id = '00000000-0000-0000-0000-00000000e2d1'),
  1, 'one audit row for the whole merge');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 26: artists merge, and the songs follow — INCLUDING the archived one.
--
-- e2d2 was absorbed in assertion 17 and is now soft-deleted, but it still
-- names artist e2b2, so this moves exactly one song: the archived one. That is
-- D-c stated as a test rather than as a comment — a repoint that filtered
-- `deleted_at is null` would answer 0 here and leave an archived song pointing
-- at an archived artist, which is how one uuid comes to mean two things.
select is(
  public.merge_artists('00000000-0000-0000-0000-00000000e2b1',
    array['00000000-0000-0000-0000-00000000e2b2']::uuid[], 'one spelling'),
  1, 'merge_artists moves the archived song too — withdrawn children are not orphans');

-- 27: an already-absorbed record cannot be merged again — it is archived, and
-- the core's scoped lock never finds it.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], 'again')
$$, 'P0002', null, 'a record already absorbed cannot be absorbed twice');

reset role;

-- 28: all five doors exist and are callable by authenticated.
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('merge_songs', 'merge_artists', 'merge_record_labels',
                        'merge_music_genres', 'merge_shows')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  5, 'five doors, all granted to authenticated');
```

> **Note on assertion 26:** it asserts `1`, and the one is the *archived* song `e2d2` — absorbed in assertion 17, still naming artist `e2b2`. This is the assertion that fails if somebody "tidies" the repoint by adding `and deleted_at is null` to it, which looks like an improvement and silently strands every withdrawn child. Assertion 22's count is scoped to the song loser, so it is unaffected by this merge.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.merge_songs(uuid, uuid[], text) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0106_music_merge_doors.sql`:

```sql
-- supabase/migrations/0106_music_merge_doors.sql

-- Block 7b, Task 2: THE FIRST MERGE IN THIS CODEBASE.
--
-- One private core, five public doors — the shape §4 prescribes and the shape
-- 0100 already used for the reference doors. The listener merge ruled for on
-- 2026-08-01 and still unbuilt should inherit this, and it moves participations,
-- winners and documents, which is more delicate than music but is the same act.
--
-- THE CORE IS PRIVATE, in the shape of apply_winner_transition (0092):
-- SECURITY INVOKER, EXECUTE granted to nobody. It is reachable only from
-- inside the five SECURITY DEFINER doors below, which have already established
-- who the caller is and which Station they hold music.merge in.

create function public.apply_music_merge(
  p_kind       public.music_merge_kind,
  p_company_id uuid,
  p_winner_id  uuid,
  p_loser_ids  uuid[],
  p_reason     text
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_merge_table(p_kind);
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_losers  uuid[];
  v_all     uuid[];
  v_org     uuid;
  v_locked  integer := 0;
  v_row     record;
  v_loser   uuid;
  v_moved   integer;
  v_total   integer := 0;
begin
  -- Mandatory (§3.4), and blank is not a reason. Refused before anything is
  -- read, so a caller cannot use a reasonless call to probe for existence.
  if v_reason is null then
    raise exception 'a merge needs a reason' using errcode = '22023';
  end if;

  -- Distinct and non-null. The screen sends what the operator ticked, and a
  -- duplicate id in that array would otherwise archive one record and write
  -- two history rows claiming two different child counts for it.
  select coalesce(array_agg(distinct l), '{}'::uuid[]) into v_losers
    from unnest(coalesce(p_loser_ids, '{}'::uuid[])) as l
   where l is not null;

  if coalesce(array_length(v_losers, 1), 0) = 0 then
    raise exception 'a merge needs at least one record to absorb' using errcode = '22023';
  end if;

  if p_winner_id = any(v_losers) then
    raise exception 'the surviving record cannot also be one of the ones being absorbed'
      using errcode = '22023';
  end if;

  v_all := v_losers || p_winner_id;

  -- ONE ordered pass over winner AND losers together (D-b). Not the winner
  -- first: two operators merging an overlapping pair in opposite directions —
  -- A says "W wins, L loses", B says the reverse — would deadlock under
  -- winner-first ordering, and queue safely under this one. The LockRows node
  -- sits above the Sort, so the rows really are locked in id order.
  --
  -- SCOPED TO THE STATION (D-a), which is what makes §4's "refuses records
  -- belonging to different Stations" true by construction rather than by a
  -- comparison. A comparison would be an oracle: a caller holding music.merge
  -- in Station A could learn whether a uuid names a live song in Station B by
  -- reading which of two messages came back. Scoped this way, a loser in
  -- another Station is simply not found, and answers the identical P0002 as a
  -- uuid that names nothing anywhere.
  --
  -- `deleted_at is null` is here for the same reason 0100's doors carry it:
  -- the composite foreign keys reference a non-partial constraint and cannot
  -- see deleted_at, so this is the only thing standing between an archived row
  -- and a second merge that would resurrect it into the winner's history.
  for v_row in execute format(
    'select id, organization_id from public.%I
      where id = any($1) and company_id = $2 and deleted_at is null
      order by id
      for update', v_table)
    using v_all, p_company_id
  loop
    v_locked := v_locked + 1;
    v_org := v_row.organization_id;
  end loop;

  -- Every id named must be present, live and in this Station. One message for
  -- all three, deliberately: they are the same answer from outside.
  if v_locked <> array_length(v_all, 1) then
    raise exception 'one of these records is missing, already archived, or in another station'
      using errcode = 'P0002';
  end if;

  foreach v_loser in array v_losers
  loop
    -- The only part that varies by kind: five one-line updates.
    --
    -- Withdrawn children move with the live ones (D-c). No `deleted_at is
    -- null` filter here, on purpose: a withdrawn request still points
    -- somewhere, and leaving it aimed at the row this merge is about to
    -- archive would make one uuid mean two different things depending on
    -- which side of deleted_at the reader is on.
    if p_kind = 'SONG' then
      update public.music_requests
         set song_id = p_winner_id, updated_at = now()
       where song_id = v_loser;
    elsif p_kind = 'ARTIST' then
      update public.songs
         set artist_id = p_winner_id, updated_at = now()
       where artist_id = v_loser;
    elsif p_kind = 'LABEL' then
      update public.songs
         set label_id = p_winner_id, updated_at = now()
       where label_id = v_loser;
    elsif p_kind = 'GENRE' then
      update public.songs
         set genre_id = p_winner_id, updated_at = now()
       where genre_id = v_loser;
    elsif p_kind = 'SHOW' then
      update public.music_requests
         set show_id = p_winner_id, updated_at = now()
       where show_id = v_loser;
    else
      -- Unreachable while music_merge_table is total, and loud rather than
      -- silent if a sixth kind is ever added to the enum without a branch here.
      raise exception 'no repoint rule for merge kind %', p_kind using errcode = 'XX000';
    end if;

    get diagnostics v_moved = row_count;
    v_total := v_total + v_moved;

    insert into public.music_merges
      (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved, merged_by)
    values
      (v_org, p_company_id, p_kind, p_winner_id, v_loser, v_reason, v_moved, v_actor);

    -- NEVER a delete. This project deletes nothing, and the history row above
    -- needs something to keep pointing at.
    execute format(
      'update public.%I set deleted_at = now(), updated_at = now() where id = $1', v_table)
      using v_loser;
  end loop;

  -- One audit row for the operation, not one per loser: the operator pressed
  -- one button, and music_merges already carries the per-loser detail.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'merge_music', v_table, p_winner_id, v_org, p_company_id,
     jsonb_build_object('kind', p_kind, 'losers', v_losers,
                        'children_moved', v_total, 'reason', v_reason));

  return v_total;
end;
$$;

revoke execute on function
  public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text) from public;

comment on function
  public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text) is
  'Collapses one or more records into a survivor, in one transaction: locks winner and losers together in id order and scoped to the Station, refuses a winner named among the losers, refuses any id that is missing/archived/elsewhere, repoints the children, writes one music_merges row per loser and soft-deletes it. Returns the total number of children repointed. Atomic on purpose, and deliberately the opposite of 6d''s sweep, which commits per winner: there an unattended sweep must not let one bad row stop every Station; here one operator pressed one button, and half a merge is worse than none. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody — the five doors below are the only callers.';

-- ---------------------------------------------------------------------------
-- The five doors. Each checks music.merge at the winner's Station BEFORE
-- revealing whether the record exists — 0093's rule, and the same
-- one-gated-query idiom update_music_reference (0100) uses: `not found` covers
-- no such id, an id in a Station this caller holds nothing in, and an
-- already-archived row, all answering 42501 alike.
--
-- Five near-identical bodies rather than one door taking a kind, on 0027's
-- reasoning: the caller is a screen with a kind already in hand, and a single
-- door taking p_kind would let a UI bug aimed at genres archive songs. Five
-- names are five distinct capabilities in an audit log and five distinct
-- things to grep for. What they share — everything that could drift — is in
-- the core.
-- ---------------------------------------------------------------------------

create function public.merge_songs(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.songs
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_songs denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('SONG', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_artists(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.artists
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_artists denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('ARTIST', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_record_labels(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.record_labels
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_record_labels denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('LABEL', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_music_genres(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.music_genres
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_music_genres denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('GENRE', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

-- The fifth door, and the one D3 did not originally have. The owner ruled for
-- it on 2026-08-04: a duplicated programme splits Block 8's per-show numbers
-- exactly as a duplicated song splits "most requested", and shows had no other
-- cure. 0105 re-issues 0098's table comment, which recorded the gap.
create function public.merge_shows(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.shows
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_shows denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('SHOW', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

comment on function public.merge_songs(uuid, uuid[], text) is
  'Absorbs one or more duplicate songs into a survivor, moving their music_requests. Gated on music.merge at the winner''s Station, checked before existence — an unknown id and an unauthorised Station both answer 42501. Returns the number of requests repointed.';
comment on function public.merge_artists(uuid, uuid[], text) is
  'Absorbs one or more duplicate artists into a survivor, moving their songs. Gated on music.merge. Returns the number of songs repointed.';
comment on function public.merge_record_labels(uuid, uuid[], text) is
  'Absorbs one or more duplicate record labels into a survivor, moving their songs. Gated on music.merge. Returns the number of songs repointed.';
comment on function public.merge_music_genres(uuid, uuid[], text) is
  'Absorbs one or more duplicate genres into a survivor, moving their songs. Gated on music.merge. A duplicated genre splits Block 8''s "most requested category" exactly as a duplicated song splits "most requested". Returns the number of songs repointed.';
comment on function public.merge_shows(uuid, uuid[], text) is
  'Absorbs one or more duplicate programmes into a survivor, moving their music_requests. Gated on music.merge. The fifth door, added on the owner''s 2026-08-04 ruling against D3''s original four. Returns the number of requests repointed.';

revoke execute on function public.merge_songs(uuid, uuid[], text)         from public;
revoke execute on function public.merge_artists(uuid, uuid[], text)       from public;
revoke execute on function public.merge_record_labels(uuid, uuid[], text) from public;
revoke execute on function public.merge_music_genres(uuid, uuid[], text)  from public;
revoke execute on function public.merge_shows(uuid, uuid[], text)         from public;

grant execute on function public.merge_songs(uuid, uuid[], text)         to authenticated;
grant execute on function public.merge_artists(uuid, uuid[], text)       to authenticated;
grant execute on function public.merge_record_labels(uuid, uuid[], text) to authenticated;
grant execute on function public.merge_music_genres(uuid, uuid[], text)  to authenticated;
grant execute on function public.merge_shows(uuid, uuid[], text)         to authenticated;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:test`
Expected: PASS, 28 assertions in `16_music_merge`.

- [ ] **Step 5: Prove the child repoint by mutation, not by reading**

Temporarily comment out the `update public.music_requests set song_id = …` line in the `SONG` branch. Run `npm run db:test`.
Expected: assertions 17, 18, 19 and 24 FAIL. Restore the line and confirm green again.

Record the observed failure list in the task's notes — this is the evidence that the test would catch a forgotten `update`, which is the one defect §6 names.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0106_music_merge_doors.sql supabase/tests/16_music_merge.test.sql
git commit -m "feat(music): one private core and five doors, so a duplicate can be collapsed"
```

---

## Task 3: The request doors, and the list that restates D6 by hand

**Files:**
- Create: `supabase/migrations/0107_music_requests_rpcs.sql`
- Create: `supabase/tests/17_music_requests.test.sql`

**Interfaces:**
- Produces:
  - `public.create_music_request(p_company_id uuid, p_member_id uuid, p_song_id uuid, p_show_id uuid default null, p_requested_at timestamptz default null) returns uuid`
  - `public.archive_music_request(p_request_id uuid) returns void`
  - `public.list_music_requests(p_company_id uuid, p_song_id uuid default null, p_show_id uuid default null, p_channel public.music_request_channel default null, p_search text default null, p_cursor_at timestamptz default null, p_cursor_id uuid default null, p_walking_back boolean default false, p_limit integer default 51) returns table (request_id uuid, member_id uuid, member_name text, member_phone text, song_id uuid, song_title text, song_archived boolean, artist_name text, show_id uuid, show_name text, channel public.music_request_channel, requested_at timestamptz, total_count integer)`

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/17_music_requests.test.sql`. Fixtures live in the `…00e3xx` range.

```sql
begin;
select plan(16);

-- Block 7b, Task 3: the request doors, and D6's three rules.
--
-- Rules 2 and 3 need TWO identities with DIFFERENT grants, which is what
-- tests/isolation/music-merge.test.ts is for. What is provable here is the
-- mechanics: the write, the MANUAL channel a caller cannot override, the
-- Station-link requirement, and the shape of the list.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e3f1', 'Org 7b requests');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e3c1', '00000000-0000-0000-0000-00000000e3f1',
   'Station 7b requests', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e3c2', '00000000-0000-0000-0000-00000000e3f1',
   'Station 7b requests two', 'America/Sao_Paulo');

-- The actor holds music.view, music.request AND members.view, so it can read
-- back what it wrote. The withholding cases need a second, narrower identity
-- and live in the isolation suite.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e3a1', '00000000-0000-0000-0000-00000000e3f1',
   'Request taker 7b');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e3a1', 'music.view'),
  ('00000000-0000-0000-0000-00000000e3a1', 'music.request'),
  ('00000000-0000-0000-0000-00000000e3a1', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e3a2', 'request-taker-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e3a2', '00000000-0000-0000-0000-00000000e3c1',
   '00000000-0000-0000-0000-00000000e3f1', '00000000-0000-0000-0000-00000000e3a1');

insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e3b1', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Marisa Monte');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e3d1', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Amor I Love You', '00000000-0000-0000-0000-00000000e3b1');
-- `e3aa`, not `e3s1`: a uuid is hexadecimal, and 's' is not a hex digit —
-- Postgres refuses the literal outright, which is a fixture that fails at
-- parse time rather than a test that fails informatively.
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e3aa', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Tarde Musical');

-- Two listeners: one linked to this Station, one not linked to any.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-00000000e3e1', '00000000-0000-0000-0000-00000000e3f1',
   'Bruno Ouvinte', '+5511999990001'),
  ('00000000-0000-0000-0000-00000000e3e2', '00000000-0000-0000-0000-00000000e3f1',
   'Unlinked Listener', '+5511999990002');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000e3e1', '00000000-0000-0000-0000-00000000e3c1',
   '00000000-0000-0000-0000-00000000e3f1');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e3a2", "role": "authenticated"}';

-- 1: the write.
select lives_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c1',
    '00000000-0000-0000-0000-00000000e3e1',
    '00000000-0000-0000-0000-00000000e3d1',
    '00000000-0000-0000-0000-00000000e3aa')
$$, 'create_music_request records a request');

-- 2: a listener with no link to this Station is refused. 0098's own comment
-- says the constraint proves the Organization and this door checks the link.
select throws_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c1',
    '00000000-0000-0000-0000-00000000e3e2',
    '00000000-0000-0000-0000-00000000e3d1')
$$, 'P0002', null, 'a listener not linked to this Station cannot have a request recorded');

-- 3: a song from another Station is refused, and not by the foreign key alone.
select throws_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c2',
    '00000000-0000-0000-0000-00000000e3e1',
    '00000000-0000-0000-0000-00000000e3d1')
$$, '42501', null, 'a Station the caller holds nothing in is refused before anything is resolved');

reset role;

-- 4: MANUAL, and the caller had no say. There is no p_channel parameter, so
-- a hand-typed row cannot be labelled an import — Block 9 gets its own door.
select is(
  (select channel::text from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e3d1' limit 1),
  'MANUAL', 'a request recorded by hand is MANUAL and nothing else');

-- 5: create_music_request takes exactly five arguments and none of them is a
-- channel. Pinned, because adding one later is the silent way this rule dies.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_music_request'
      and pg_get_function_arguments(p.oid) not like '%channel%'),
  1, 'create_music_request offers no channel parameter');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e3a2", "role": "authenticated"}';

-- 6-9: the list returns the row, with the listener's identity, the song and
-- the show — this actor holds members.view.
select is(
  (select count(*)::int from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  1, 'the list returns the one request');
select is(
  (select member_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Bruno Ouvinte', 'the listener''s name is returned to a caller holding members.view');
select is(
  (select song_title from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Amor I Love You', 'the song title comes with the row');
select is(
  (select show_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Tarde Musical', 'the programme comes with the row');

-- 10: the artist's name too — a request list that cannot say who sings it is
-- half a list.
select is(
  (select artist_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Marisa Monte', 'the artist''s name comes with the row');

-- 11: total_count agrees with the rows, computed from the same CTE.
select is(
  (select total_count from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  1, 'total_count is the filtered total');

-- 12: a Station the caller holds nothing in is a refusal, never an empty page.
select throws_ok($$
  select * from public.list_music_requests('00000000-0000-0000-0000-00000000e3c2')
$$, '42501', null, 'the list refuses rather than returning an empty page');

-- 13: the song filter narrows.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-00000000e3c1', '00000000-0000-0000-0000-0000000000ff')),
  0, 'the song filter narrows to nothing when no request names that song');

-- 14: withdrawing a mistyped entry.
select lives_ok($$
  select public.archive_music_request(
    (select id from public.music_requests
      where song_id = '00000000-0000-0000-0000-00000000e3d1' limit 1))
$$, 'archive_music_request withdraws a request');

-- 15: and it leaves the list.
select is(
  (select count(*)::int from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  0, 'a withdrawn request leaves the list');

reset role;

-- 16: but it is still a row. This project deletes nothing.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e3d1' and deleted_at is not null),
  1, 'the withdrawn request is soft-deleted, not removed');

select * from finish();
rollback;
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.create_music_request(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0107_music_requests_rpcs.sql`:

```sql
-- supabase/migrations/0107_music_requests_rpcs.sql

-- Block 7b, Task 3: the doors onto music_requests, and the list.
--
-- The table landed in 0098 with nothing writing to it. This is what writes,
-- withdraws and reads it.

-- ---------------------------------------------------------------------------
-- The write. Gated on music.request (D8), which is its own code because
-- recording what a listener asked for is a different job from maintaining the
-- catalogue.
--
-- NO CHANNEL PARAMETER, deliberately. §3.3 gives the column MANUAL | IMPORT
-- and this door writes MANUAL unconditionally, so a hand-typed row cannot be
-- labelled an import by a caller. record_participation (0054) does take a
-- p_source and its own comment calls it "recorded, not consulted" — that is a
-- wider door than this block needs, and 0101's warning about "a parameter that
-- looks like it decides something while deciding nothing" points the other
-- way. Block 9's ETL gets its own door, the way import_participations is
-- separate from record_participation.
-- ---------------------------------------------------------------------------

create function public.create_music_request(
  p_company_id   uuid,
  p_member_id    uuid,
  p_song_id      uuid,
  p_show_id      uuid        default null,
  p_requested_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  -- Permission first, existence second (0093). has_permission is false for a
  -- Station that does not exist and for one that is suspended, so this answers
  -- 42501 without confirming whether the id names anything.
  if not public.has_permission('music.request', p_company_id) then
    raise log 'create_music_request denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- The listener must be reachable FROM THIS STATION. 0098's composite foreign
  -- key proves only the Organization — members are Organization-scoped (0031),
  -- so the same person entering at two of the group's Stations is one row —
  -- and which Stations may see them is member_company_links' business. 0098's
  -- own comment says this door checks that link; this is it.
  --
  -- An anonymised listener is excluded for the reason searchStationListeners
  -- gives: 0034 scrubs full_name, so the row would be a blank line nobody can
  -- identify, and recording fresh activity against somebody who exercised
  -- erasure is precisely what that erasure was for.
  -- `for share of m`, not a bare `exists`: the same lock, for the same reason,
  -- that record_member_consent, add_member_note and block_member (0034) all
  -- take on the member row. anonymize_member takes FOR UPDATE on it, and
  -- FOR SHARE conflicts with that, so the two serialise. Without the lock an
  -- erasure committing between this check and the INSERT below leaves a
  -- brand-new request attached to an erased listener — which is precisely the
  -- outcome the paragraph above says the exclusion exists to prevent.
  perform 1 from public.members m
    join public.member_company_links l on l.member_id = m.id
   where m.id = p_member_id
     and m.organization_id = v_org
     and l.company_id = p_company_id
     and m.deleted_at is null
     and m.anonymized_at is null
   for share of m;

  if not found then
    raise exception 'listener not found in this station: %', p_member_id using errcode = 'P0002';
  end if;

  -- The song and the show are proved by the composite foreign keys 0098
  -- declares — a song from another Station cannot be inserted at all. What
  -- those keys CANNOT see is deleted_at (they reference a non-partial
  -- constraint), so an archived song would otherwise be a legal target.
  --
  -- FOR KEY SHARE, NOT A BARE `exists` — and this is 0103's defect one level
  -- down, caught in review before it was written a second time.
  --
  -- 0106's merge takes FOR UPDATE on the song and the show it is about to
  -- archive. A plain read takes no row lock and is never blocked by one, so
  -- under READ COMMITTED this sequence commits a live request naming a song
  -- that no longer exists to any reader:
  --   1. merge_songs locks the loser FOR UPDATE and starts repointing;
  --   2. create_music_request reads the loser as live — the merge has not
  --      committed — and returns from its check;
  --   3. the merge commits, archiving the loser;
  --   4. the INSERT lands, and 0099's policy makes its song unreadable.
  -- The request is then a row the Requests screen shows with a title only
  -- list_music_requests can still see, pointing at a song the merge already
  -- counted and moved past. It is exactly the state 0103 was written to close
  -- for songs naming artists, and 0027 for movements naming prizes.
  --
  -- FOR KEY SHARE is the mode with exactly one conflict — FOR UPDATE — which
  -- is the whole requirement: it serialises against the merge's archive and
  -- against nothing else, so two concurrent requests for the same song never
  -- queue behind each other and an ordinary rename (FOR NO KEY UPDATE) does
  -- not block either. 0103's header sets out the reasoning in full.
  --
  -- `perform` rather than `if not exists`, because `exists` discards the lock:
  -- the row has to actually be selected for FOR KEY SHARE to be taken on it.
  perform 1 from public.songs
    where id = p_song_id and company_id = p_company_id and deleted_at is null
    for key share;

  if not found then
    raise exception 'song not found in this station: %', p_song_id using errcode = 'P0002';
  end if;

  if p_show_id is not null then
    perform 1 from public.shows
      where id = p_show_id and company_id = p_company_id and deleted_at is null
      for key share;

    if not found then
      raise exception 'programme not found in this station: %', p_show_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel, requested_at, created_by)
  values
    (v_org, p_company_id, p_member_id, p_song_id, p_show_id, 'MANUAL',
     coalesce(p_requested_at, now()), v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_music_request', 'music_requests', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'song_id', p_song_id, 'show_id', p_show_id));

  return v_id;
end;
$$;

comment on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) is
  'Records by hand that a listener asked for a song. Gated on music.request, checked before the Station is resolved. The channel is always MANUAL and there is no parameter to say otherwise — Block 9''s ETL gets its own door rather than this one being widened. The listener must be linked to this Station and not anonymised; the song and the programme must be live in it, which the composite foreign keys cannot check because they cannot see deleted_at.';

-- ---------------------------------------------------------------------------
-- The withdrawal. Gated on music.request, not music.merge: §D5 says
-- deleted_at exists on this table only so a MISTYPED MANUAL ENTRY can be
-- withdrawn, and whoever may record one is who notices they typed it wrong.
-- music.merge is the destructive code for the CATALOGUE, where the loss is a
-- record other rows point at; withdrawing a request loses one historical fact
-- that the same person just created.
-- ---------------------------------------------------------------------------

create function public.archive_music_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  -- 0093's one-gated-query idiom: no such id, an id in a Station this caller
  -- holds nothing in, and an already-withdrawn row all answer 42501 alike.
  select organization_id, company_id into v_org, v_company
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('music.request', company_id);

  if v_company is null then
    raise log 'archive_music_request denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  update public.music_requests
     set deleted_at = now(), updated_at = now()
   where id = p_request_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_music_request', 'music_requests', p_request_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.archive_music_request(uuid) is
  'Withdraws a request. Gated on music.request rather than a destructive code, because D5 puts deleted_at on this table for one purpose only: a mistyped manual entry. Never a DELETE.';

-- ---------------------------------------------------------------------------
-- The list. SECURITY DEFINER, so what 0099's policy would have done for free
-- is done here by hand — D6, which is not a new decision: it is what
-- list_participations (0090) and list_pickups (0095) already do, and 0090
-- writes out the reasoning in full.
--
--   * RULE 1 — music.view at this Station, or a 42501. An empty page would be
--     indistinguishable from a Station where nobody has asked for anything;
--   * RULE 2 — the listener's name and phone ONLY to a caller holding
--     members.view. Without it THE LIST STILL LISTS, every row, with those two
--     null;
--   * RULE 3 — a SEARCH without members.view returns NOTHING. Searching a
--     field you may not read answers "is there a listener called X here?" to
--     somebody forbidden the name itself.
--
-- ONE THING THIS LIST DOES THAT THE OTHER TWO DO NOT: it returns an ARCHIVED
-- song's title, marked. archive_song (0101) is deliberately never refused over
-- a live request naming it — a request is a historical fact that outlives the
-- song — so a request CAN point at a song 0099's policy has made unreadable.
-- Reading it from inside this body is the only way the row is legible at all;
-- hiding the title would leave the operator a request for nothing. song_archived
-- is returned beside it so the screen can say which it is rather than implying
-- the song is still in the catalogue.
--
-- Keyset on (requested_at desc, id desc). requested_at is NOT NULL (0098), so
-- there is no null region and plain tuple comparison is enough — this is
-- list_participations' shape, not list_pickups', which needed regions because
-- deadline_at is nullable.
-- ---------------------------------------------------------------------------

create function public.list_music_requests(
  p_company_id   uuid,
  p_song_id      uuid    default null,
  p_show_id      uuid    default null,
  p_channel      public.music_request_channel default null,
  p_search       text    default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 51
)
returns table (
  request_id    uuid,
  member_id     uuid,
  member_name   text,
  member_phone  text,
  song_id       uuid,
  song_title    text,
  song_archived boolean,
  artist_name   text,
  show_id       uuid,
  show_name     text,
  channel       public.music_request_channel,
  requested_at  timestamptz,
  total_count   integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_names  boolean;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- RULE 1.
  if not public.has_permission('music.view', p_company_id) then
    raise log 'list_music_requests denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: music.view required' using errcode = '42501';
  end if;

  -- RULE 2.
  v_names := public.has_permission('members.view', p_company_id);

  -- RULE 3.
  if v_search is not null and not v_names then
    return;
  end if;

  return query
  with visible as (
    select r.id, r.member_id, r.song_id, r.show_id, r.channel, r.requested_at,
           m.full_name, m.phone,
           s.title as song_title,
           (s.deleted_at is not null) as song_archived,
           a.name as artist_name,
           sh.name as show_name
      from public.music_requests r
      join public.members m on m.id = r.member_id
      join public.songs   s on s.id = r.song_id
      join public.artists a on a.id = s.artist_id
      left join public.shows sh on sh.id = r.show_id
     where r.company_id = p_company_id
       and r.deleted_at is null
       and (p_song_id is null or r.song_id = p_song_id)
       and (p_show_id is null or r.show_id = p_show_id)
       and (p_channel is null or r.channel = p_channel)
       and (v_search is null or m.full_name ilike '%' || v_search || '%'
                             or public.normalize_phone(m.phone)
                                  like '%' || public.normalize_phone(v_search) || '%')
  )
  select f.id,
         f.member_id,
         case when v_names then f.full_name else null end,
         case when v_names then f.phone else null end,
         f.song_id,
         f.song_title,
         f.song_archived,
         f.artist_name,
         f.show_id,
         f.show_name,
         f.channel,
         f.requested_at,
         -- From the SAME CTE the rows come from, so a page and its count
         -- cannot narrow differently (0090's rule).
         (select count(*) from visible)::integer as total_count
    from visible f
   -- BOTH halves, the shape 0090 and 0096 use for a NOT NULL sort key. 0095
   -- guards on p_cursor_id alone and its own comment says why it cannot do
   -- otherwise — deadline_at is nullable there, so a null cursor timestamp is
   -- a real position. requested_at is NOT NULL, so a null here is a malformed
   -- cursor, and `requested_at < null` would evaluate to NULL and return zero
   -- rows — no rows, and therefore no total_count either. An empty page, from
   -- the one list whose RULE 1 exists to guarantee empty pages never happen.
   where p_cursor_at is null
      or p_cursor_id is null
      or (
        case when p_walking_back then
          -- Toward earlier positions in display order (newest first).
          f.requested_at > p_cursor_at
          or (f.requested_at = p_cursor_at and f.id > p_cursor_id)
        else
          f.requested_at < p_cursor_at
          or (f.requested_at = p_cursor_at and f.id < p_cursor_id)
        end
      )
   -- Newest first. Walking back reads the opposite of display order so LIMIT
   -- keeps the rows nearest the cursor, and the caller reverses the small
   -- batch — list_participations' own shape.
   order by
     case when p_walking_back then f.requested_at end asc,
     case when p_walking_back then f.id end asc,
     case when not p_walking_back then f.requested_at end desc,
     case when not p_walking_back then f.id end desc
   limit p_limit;
end;
$$;

comment on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) is
  'One keyset page of a Station''s music requests, newest first. SECURITY DEFINER, so D6''s three rules are restated by hand: (1) music.view or a 42501 rather than an empty page; (2) the listener''s name and phone only to a caller holding members.view — without it the list still lists, every row, with those two null; (3) a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle (0090 argues it in full). Returns an ARCHIVED song''s title with song_archived true rather than hiding it: archive_song is deliberately never refused over a live request naming it, so such rows exist and would otherwise be illegible. total_count is computed from the same CTE the rows come from.';

revoke execute on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) from public;
revoke execute on function public.archive_music_request(uuid) from public;
revoke execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) from public;

grant execute on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.archive_music_request(uuid) to authenticated;
grant execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) to authenticated;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:test`
Expected: PASS, 16 assertions in `17_music_requests`.

- [ ] **Step 5: Verify the fixture's column names against the real schema**

Run:
```bash
grep -n "anonymized_at\|member_company_links" supabase/migrations/0031*.sql supabase/migrations/0034*.sql | head -20
```
Confirm `members.anonymized_at` and `member_company_links (member_id, company_id, organization_id)` are spelled exactly as the migration above assumes. **If they differ, fix the migration, not the test.**

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0107_music_requests_rpcs.sql supabase/tests/17_music_requests.test.sql
git commit -m "feat(music): record what a listener asked for, and read it back under D6's rules"
```

---

## Task 4: The Maintenance screen's one read

**Files:**
- Create: `supabase/migrations/0108_list_merge_candidates.sql`
- Modify: `supabase/tests/16_music_merge.test.sql` (raise `plan(28)` to `plan(32)`)

**Interfaces:**
- Produces: `public.list_merge_candidates(p_company_id uuid, p_kind public.music_merge_kind, p_search text default null, p_limit integer default 100) returns table (id uuid, label text, sub_label text, child_count integer, legacy_id text)`

**Why this exists, stated before the code:** the Maintenance screen asks the operator to name *which duplicate stays*. Choosing between two rows without knowing that one has three hundred requests behind it and the other has none is a coin flip, and the merge is not reversible. `child_count` is the number the operator actually needs. One `SECURITY DEFINER` read gated on `music.merge` gives it in a single query, where the alternative is one count per candidate row from the screen.

- [ ] **Step 1: Write the failing pgTAP test**

Append to `16_music_merge.test.sql` before `finish()`, and raise the plan to 32.

```sql
-- 29-32: the Maintenance screen's read. The merge above archived e2d2 and
-- e2b2, so only the survivors remain as candidates.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

select is(
  (select count(*)::int from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  1, 'only live records are offered as merge candidates');

select is(
  (select label from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  'Sozinho', 'a song candidate is labelled by its title');

-- The number the operator needs to choose a survivor: the surviving song
-- absorbed two requests in assertion 17.
select is(
  (select child_count from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  2, 'a candidate carries the number of children a merge would move');

select throws_ok($$
  select * from public.list_merge_candidates(
    '00000000-0000-0000-0000-00000000e2c2', 'SONG')
$$, '42501', null, 'the candidate list refuses a Station the caller cannot merge in');

reset role;
```

> `00000000-0000-0000-0000-00000000e2c2` does not exist in this file's fixtures. That is deliberate and it is the point: `has_permission` is false for a Station that does not exist, so a caller cannot tell an unknown Station from an unauthorised one. If the assertion needs a real second Station to be convincing, add one to the fixture block — but the `42501` must not become a `P0002`.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.list_merge_candidates(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0108_list_merge_candidates.sql`:

```sql
-- supabase/migrations/0108_list_merge_candidates.sql

-- Block 7b, Task 4: what the Maintenance screen reads.
--
-- The screen asks the operator to name which duplicate STAYS, and the merge is
-- not reversible. child_count is the number that makes that a decision rather
-- than a coin flip: two songs with the same title, one with three hundred
-- requests behind it and one with none, are not interchangeable. One read
-- gives it for the whole page, where the alternative is one count per row from
-- the screen.
--
-- SECURITY DEFINER and gated on music.merge — the same permission as the
-- doors, because this list exists only to feed them. A caller holding
-- music.view alone reads the ordinary lists (0099's policies) and has no use
-- for this one.
--
-- sub_label is the second line a candidate needs to be told apart from its
-- duplicate: for a song, the artist. The four short lists have nothing to put
-- there and return null.

create function public.list_merge_candidates(
  p_company_id uuid,
  p_kind       public.music_merge_kind,
  p_search     text    default null,
  p_limit      integer default 100
)
returns table (
  id          uuid,
  label       text,
  sub_label   text,
  child_count integer,
  legacy_id   text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
begin
  if not public.has_permission('music.merge', p_company_id) then
    raise log 'list_merge_candidates denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  v_like := '%' || coalesce(v_search, '') || '%';

  if p_kind = 'SONG' then
    return query
      select s.id, s.title, a.name,
             (select count(*)::integer from public.music_requests r where r.song_id = s.id),
             s.legacy_id
        from public.songs s
        join public.artists a on a.id = s.artist_id
       where s.company_id = p_company_id and s.deleted_at is null
         and (v_search is null or s.title ilike v_like)
       order by s.title, s.id
       limit p_limit;

  elsif p_kind = 'ARTIST' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.artist_id = x.id),
             x.legacy_id
        from public.artists x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'LABEL' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.label_id = x.id),
             x.legacy_id
        from public.record_labels x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'GENRE' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.genre_id = x.id),
             x.legacy_id
        from public.music_genres x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'SHOW' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.music_requests r where r.show_id = x.id),
             x.legacy_id
        from public.shows x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  else
    -- Unreachable while the enum has five values, and loud rather than an
    -- empty list if a sixth is added without a branch here. An empty list
    -- would read as "no duplicates", which is the wrong answer to give
    -- somebody about to decide there is nothing to clean up.
    raise exception 'no candidate rule for merge kind %', p_kind using errcode = 'XX000';
  end if;
end;
$$;

comment on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) is
  'The Maintenance screen''s one read: every live record of one kind in one Station, with the number of children a merge would move. Gated on music.merge — this list exists only to feed the doors. child_count is what makes naming the survivor a decision rather than a coin flip, and the counts include withdrawn/archived children because apply_music_merge moves those too.';

revoke execute on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) from public;
grant execute on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) to authenticated;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:test`
Expected: PASS, 32 assertions in `16_music_merge`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0108_list_merge_candidates.sql supabase/tests/16_music_merge.test.sql
git commit -m "feat(music): tell the operator how much each duplicate is carrying"
```

---

## Task 5: The isolation suite — the boundary, with real JWTs

**Files:**
- Create: `tests/isolation/music-merge.test.ts`
- Modify: `scripts/verify-isolation-suite.mjs` (`REQUIRED_TEST_FILES`)

**Interfaces:**
- Consumes: the harness (`provisionCustomer`, `addCompany`, `grantRoleWith`, `signInAs`, `cleanupUsers`) and every RPC from Tasks 2–4.

**Why a new file rather than more cases in `music.test.ts`:** that file's `describe` is "Block 7a — the music catalogue across Stations" and its fixtures are 7a's. Two blocks' boundaries in one file makes the `minTests` floor say nothing useful about either.

- [ ] **Step 1: Write the failing test file**

Create `tests/isolation/music-merge.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 7b's boundary, proved the only way it can be: with real users holding
 * real, narrower grants.
 *
 * Every case here is invisible to pgTAP, which runs as superuser with a null
 * auth.uid(). That is not a gap in the pgTAP suite — it is why this file
 * exists, and why it is written in the same block as the functions rather than
 * at the end of it, which is the lesson Block 6c paid five commits for.
 */
// One stamp for the whole file, for the reason music.test.ts spells out:
// cleanupUsers can fail to delete a user referenced by an audited RPC, and an
// unstamped label only collides on the SECOND run — so it survives review and
// every single-run execution.
const STAMP = Date.now();

describe('Block 7b — merging and requests across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`music7b-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station 7b');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  /** Registers an artist and a song in one Station, as the owner. */
  async function seedSong(companyId: string, title: string) {
    const owner = await signInAs(customer.email, customer.password);
    const { data: artistId, error: artistError } = await owner.rpc('create_music_reference', {
      p_company_id: companyId,
      p_kind: 'ARTIST',
      p_name: `Artist for ${title}`,
    });
    expect(artistError).toBeNull();
    const { data: songId, error: songError } = await owner.rpc('create_song', {
      p_company_id: companyId,
      p_title: title,
      p_artist_id: artistId as string,
    });
    expect(songError).toBeNull();
    return { artistId: artistId as string, songId: songId as string };
  }

  it('refuses to merge without music.merge, even holding music.manage', async () => {
    const first = await seedSong(customer.companyId, 'Manager song A');
    const second = await seedSong(customer.companyId, 'Manager song B');

    // music.manage builds the catalogue and must NOT confer the power to
    // collapse it — D8's whole reason for a separate code.
    const manager = await grantRoleWith(customer, `merge-manager-${STAMP}`, [
      'music.view',
      'music.manage',
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: first.songId,
      p_loser_ids: [second.songId],
      p_reason: 'should not be allowed',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses a winner in a Station the caller cannot reach, without saying it exists', async () => {
    const hidden = await seedSong(secondCompanyId, 'Hidden station song');
    const merger = await grantRoleWith(
      customer,
      `merge-scoped-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: hidden.songId,
      p_loser_ids: [hidden.songId],
      p_reason: 'wrong station',
    });

    // 42501, never P0002: the id does exist, and the caller must not learn it.
    expect(error?.code).toBe('42501');
  });

  it('refuses a LOSER that lives in another Station, and says nothing about it', async () => {
    const mine = await seedSong(customer.companyId, 'My song');
    const theirs = await seedSong(secondCompanyId, 'Their song');

    const merger = await grantRoleWith(
      customer,
      `merge-cross-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: mine.songId,
      p_loser_ids: [theirs.songId],
      p_reason: 'cross-station',
    });

    // P0002, the SAME answer a uuid naming nothing at all gets. The core scopes
    // its lock to the winner's Station, so "elsewhere" and "nonexistent" are
    // indistinguishable — a distinct message here would be an oracle.
    expect(error?.code).toBe('P0002');
  });

  it('answers a cross-Station loser identically to a uuid that names nothing', async () => {
    const mine = await seedSong(customer.companyId, 'My other song');
    const merger = await grantRoleWith(
      customer,
      `merge-nothing-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: mine.songId,
      p_loser_ids: ['00000000-0000-0000-0000-0000000000ff'],
      p_reason: 'nonexistent',
    });

    expect(error?.code).toBe('P0002');
  });

  it('merges, and the requests really move', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const winner = await seedSong(customer.companyId, 'Survivor');
    const loser = await seedSong(customer.companyId, 'Duplicate');

    const { data: memberId, error: memberError } = await owner.rpc('resolve_or_create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Listener ${STAMP}`,
      p_phone: `+5511${String(STAMP).slice(-9)}`,
    });
    expect(memberError).toBeNull();
    const resolved = memberId as { member_id: string };

    const { error: requestError } = await owner.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: resolved.member_id,
      p_song_id: loser.songId,
    });
    expect(requestError).toBeNull();

    const { data: moved, error: mergeError } = await owner.rpc('merge_songs', {
      p_winner_id: winner.songId,
      p_loser_ids: [loser.songId],
      p_reason: 'same recording',
    });
    expect(mergeError).toBeNull();
    expect(moved).toBe(1);

    // The proof that matters, read back through the real list rather than
    // asserted from the return value alone.
    const { data: rows, error: listError } = await owner.rpc('list_music_requests', {
      p_company_id: customer.companyId,
      p_song_id: winner.songId,
    });
    expect(listError).toBeNull();
    expect((rows as unknown[]).length).toBe(1);
  });

  it('lists requests without members.view, with the listener columns null', async () => {
    // D6's rule 2: the list still LISTS. An empty page here would be a
    // different bug wearing the same clothes.
    const viewer = await grantRoleWith(customer, `req-noname-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.rpc('list_music_requests', {
      p_company_id: customer.companyId,
    });

    expect(error).toBeNull();
    const rows = data as { member_name: string | null; song_title: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.member_name === null)).toBe(true);
    // And the row is still useful: the song is there.
    expect(rows.every((r) => typeof r.song_title === 'string')).toBe(true);
  });

  it('returns nothing at all when a caller without members.view searches', async () => {
    // D6's rule 3: searching a field you may not read is an oracle.
    const viewer = await grantRoleWith(customer, `req-nosearch-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.rpc('list_music_requests', {
      p_company_id: customer.companyId,
      p_search: 'Listener',
    });

    expect(error).toBeNull();
    expect((data as unknown[]).length).toBe(0);
  });

  it('refuses to record a request without music.request', async () => {
    const song = await seedSong(customer.companyId, 'No request permission');
    const viewer = await grantRoleWith(customer, `req-denied-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: '00000000-0000-0000-0000-0000000000ff',
      p_song_id: song.songId,
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses the candidate list to a caller who cannot merge', async () => {
    const viewer = await grantRoleWith(customer, `cand-denied-${STAMP}`, [
      'music.view',
      'music.manage',
    ]);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('list_merge_candidates', {
      p_company_id: customer.companyId,
      p_kind: 'SONG',
    });

    expect(error?.code).toBe('42501');
  });

  it('has no write grant on music_merges for any caller', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner
      .from('music_merges')
      .insert({
        organization_id: customer.organizationId,
        company_id: customer.companyId,
        kind: 'SONG',
        winner_id: '00000000-0000-0000-0000-0000000000f1',
        loser_id: '00000000-0000-0000-0000-0000000000f2',
        reason: 'forged',
        children_moved: 0,
      });

    // Even the owner, who passes every permission gate, has no INSERT.
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Add the manifest entry**

In `scripts/verify-isolation-suite.mjs`, add after the `music.test.ts` entry:

```js
  // Block 7b, Task 5: the merge's boundary and D6's identity rules. The three
  // that only a second identity can prove: music.manage does NOT confer
  // music.merge; a loser in another Station answers the SAME P0002 as a uuid
  // naming nothing (the core scopes its lock, so "elsewhere" is
  // indistinguishable from "absent"); and list_music_requests still LISTS
  // without members.view, with the listener columns null, while a search
  // returns nothing at all. pgTAP sees none of it — it runs as superuser with
  // a null auth.uid().
  { path: 'tests/isolation/music-merge.test.ts', minTests: 10 },
```

- [ ] **Step 3: Run and watch it fail**

Run: `npm run test:isolation`
Expected: the new file's cases fail against the pre-migration database, or the whole run reports the pre-existing environment failure documented in `docs/block-7a-report.md` §1.1. **If it is the environment failure, say so in the task notes and do not claim the file was verified.** Verify against a local `supabase db reset` instead, and record which route was taken.

- [ ] **Step 4: Run against a fresh local database and watch it pass**

```bash
npx supabase db reset
npm run test:isolation -- music-merge
```

Expected: 10 passing cases. Note the Kong-goes-blind-after-`db reset` trap recorded in the Block 3c memory — if the API gateway stops answering, restart the local stack before concluding anything about the code.

- [ ] **Step 5: Verify the harness API names before blaming the code**

The file above assumes `provisionCustomer`, `addCompany`, `grantRoleWith(customer, label, permissions, companyIds?)`, `signInAs`, `cleanupUsers`, and `ProvisionedCustomer.organizationId`. Run:

```bash
grep -n "export async function\|export interface ProvisionedCustomer" -A 8 tests/isolation/harness.ts | head -60
```

Fix the test to match the harness. **Do not add new helpers to the harness for this task** — every call above already exists for `music.test.ts`, except `organizationId`, which the last case reads; if `ProvisionedCustomer` does not carry it, read it from the customer's company row instead.

- [ ] **Step 6: Commit**

```bash
git add tests/isolation/music-merge.test.ts scripts/verify-isolation-suite.mjs
git commit -m "test(music): the merge boundary and the identity rules, with real grants"
```

---

## Task 6: Schemas and the URL contracts

**Files:**
- Modify: `src/schemas/music.ts`
- Create: `src/app/(app)/music/requests/list-params.ts`
- Create: `src/app/(app)/music/maintenance/list-params.ts`
- Create: `tests/unit/music-merge-schema.test.ts`

**Interfaces:**
- Produces (schemas): `MUSIC_MERGE_KINDS`, `MusicMergeKind`, `MUSIC_REQUEST_CHANNELS`, `mergeFormSchema` → `{ companyId, kind, winnerId, loserIds: string[], reason }`, `requestFormSchema` → `{ companyId, memberId?, songId, showId?, requestedAt?, fullName?, phone?, email?, cpf?, passport? }`, `MERGE_REASON_MAX_LENGTH`.
- Produces (requests list-params): `MusicRequestSearchParams`, `RequestListState { companyId, stationSearch?, search?, songId?, showId?, channel? }`, `parseRequestListParams(raw)`, `requestHref(state, patch)`.
- Produces (maintenance list-params): `MaintenanceSearchParams`, `MaintenanceState { companyId, stationSearch?, kind: MusicMergeKind, search? }`, `parseMaintenanceParams(raw)`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/music-merge-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeFormSchema, requestFormSchema, MUSIC_MERGE_KINDS } from '@/schemas/music';

describe('MUSIC_MERGE_KINDS', () => {
  // Pinned against 0105. The owner ruled for merge_shows on 2026-08-04 and
  // three shipped comments predicted the opposite — this is the line that
  // fails if somebody trusts one of them.
  it('is the five the database declares, shows included', () => {
    expect([...MUSIC_MERGE_KINDS]).toEqual(['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW']);
  });
});

describe('mergeFormSchema', () => {
  const winner = '11111111-1111-1111-1111-111111111111';
  const loser = '22222222-2222-2222-2222-222222222222';
  const company = '33333333-3333-3333-3333-333333333333';

  it('accepts a survivor, its losers and a reason', () => {
    const parsed = mergeFormSchema.parse({
      companyId: company,
      kind: 'SONG',
      winnerId: winner,
      loserIds: [loser],
      reason: 'same recording, typed twice',
    });
    expect(parsed.loserIds).toEqual([loser]);
  });

  // 0106 refuses all three of these too. Catching them here turns a round trip
  // into a field-level message — the reason schemas/music.ts exists at all.
  it('refuses a merge with no reason', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [loser], reason: '   ',
      }),
    ).toThrow();
  });

  it('refuses a merge that absorbs nobody', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [], reason: 'why',
      }),
    ).toThrow();
  });

  it('refuses a survivor that is also being absorbed', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [winner], reason: 'why',
      }),
    ).toThrow();
  });

  it('collapses a duplicate loser rather than sending it twice', () => {
    const parsed = mergeFormSchema.parse({
      companyId: company, kind: 'SONG', winnerId: winner, loserIds: [loser, loser], reason: 'why',
    });
    expect(parsed.loserIds).toEqual([loser]);
  });
});

describe('requestFormSchema', () => {
  const company = '33333333-3333-3333-3333-333333333333';
  const song = '44444444-4444-4444-4444-444444444444';

  it('accepts a listener already picked', () => {
    const parsed = requestFormSchema.parse({
      companyId: company, songId: song, memberId: '55555555-5555-5555-5555-555555555555',
    });
    expect(parsed.songId).toBe(song);
  });

  it('accepts a listener to be created from a name', () => {
    const parsed = requestFormSchema.parse({
      companyId: company, songId: song, fullName: 'Ana Ouvinte', phone: '+5511999990001',
    });
    expect(parsed.fullName).toBe('Ana Ouvinte');
  });

  // D5: every request belongs to a registered listener. Neither a picked id nor
  // the fields to register one means there is nobody to attach it to.
  it('refuses a request that names no listener at all', () => {
    expect(() => requestFormSchema.parse({ companyId: company, songId: song })).toThrow();
  });

  it('refuses a request with no song — never free text', () => {
    expect(() =>
      requestFormSchema.parse({ companyId: company, fullName: 'Ana' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/music-merge-schema.test.ts`
Expected: FAIL — `mergeFormSchema` is not exported.

- [ ] **Step 3: Add the schemas**

Append to `src/schemas/music.ts`:

```ts
/** The five 0105's music_merge_kind carries. Shows are here on the owner's 2026-08-04 ruling. */
export const MUSIC_MERGE_KINDS = ['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'] as const;
export type MusicMergeKind = (typeof MUSIC_MERGE_KINDS)[number];

export const MUSIC_REQUEST_CHANNELS = ['MANUAL', 'IMPORT'] as const;

/**
 * A reason has to fit in a sentence somebody will read in six months.
 * `text` in Postgres has no length of its own, so the bound is here.
 */
export const MERGE_REASON_MAX_LENGTH = 300;

/**
 * Mirrors 0106's three refusals, so each arrives as a field-level message
 * instead of a round trip: a blank reason, an empty loser list, and a survivor
 * named among the losers.
 *
 * The duplicate collapse is here as well as in the core. The core dedupes
 * because a repeated id would archive one record and write two history rows
 * claiming different child counts for it; this dedupes because a checkbox list
 * that somehow submits the same id twice should not depend on the database to
 * be correct about it.
 */
export const mergeFormSchema = z
  .object({
    companyId: z.string().uuid(),
    kind: z.enum(MUSIC_MERGE_KINDS),
    winnerId: z.string().uuid('Choose which record stays.'),
    loserIds: z
      .array(z.string().uuid())
      .min(1, 'Choose at least one record to absorb.')
      .transform((ids) => [...new Set(ids)]),
    reason: z
      .string()
      .trim()
      .min(1, 'Say why these are the same record.')
      .max(MERGE_REASON_MAX_LENGTH),
  })
  .refine((v) => !v.loserIds.includes(v.winnerId), {
    message: 'The record that stays cannot also be one of the ones being absorbed.',
    path: ['winnerId'],
  });

export type MergeFormInput = z.infer<typeof mergeFormSchema>;

/**
 * Manual entry, which has two shapes because Block 3's deduplication has two:
 * the operator either picked a listener from the search results (`memberId`)
 * or typed enough to find-or-create one (`fullName` and at least one
 * identifier). resolveOrCreateMember (services/participations.ts) is what
 * turns the second into the first, and the form calls it before the request
 * door — the same two doors record-participation-form.tsx already has.
 *
 * D5: `songId` is required and there is no free-text alternative. A request
 * points at a catalogued song or it is not recorded.
 */
export const requestFormSchema = z
  .object({
    companyId: z.string().uuid(),
    songId: z.string().uuid('Choose a song — a request never points at free text.'),
    showId: optionalUuid,
    memberId: optionalUuid,
    requestedAt: optionalText(40),
    fullName: optionalText(160),
    phone: optionalText(40),
    email: optionalText(160),
    cpf: optionalText(20),
    passport: optionalText(40),
  })
  .refine((v) => Boolean(v.memberId) || Boolean(v.fullName), {
    message: 'Pick a listener, or give a name to register one.',
    path: ['memberId'],
  });

export type RequestFormInput = z.infer<typeof requestFormSchema>;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/unit/music-merge-schema.test.ts`
Expected: PASS, 11 assertions.

- [ ] **Step 5: Write the two URL contracts**

Create `src/app/(app)/music/requests/list-params.ts`, modelled line for line on `src/app/(app)/music/songs/list-params.ts` — read that file first and follow it, including the `stationSearch` doc comment, which is now the rule `src/lib/station-switch.ts` enforces:

```ts
import type { SortDirection } from '@/lib/keyset';

export interface MusicRequestSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  song?: string;
  show?: string;
  channel?: string;
  after?: string;
  before?: string;
}

export interface RequestListState {
  companyId: string;
  /** Carried by every link on the screen — see src/lib/station-switch.ts for what dropping it costs. */
  stationSearch?: string;
  /** A listener search. Returns nothing at all without members.view — 0107's RULE 3, not a bug. */
  search?: string;
  songId?: string;
  showId?: string;
  channel?: 'MANUAL' | 'IMPORT';
}

export interface RequestCursor {
  side: 'after' | 'before';
  value: string;
}

/** Newest first, and there is no second sort: a request list is read as a diary. */
export const REQUEST_DIRECTION: SortDirection = 'desc';
```

Complete it with `parseRequestListParams` and `requestHref` following `songs/list-params.ts`'s own functions exactly. Create `src/app/(app)/music/maintenance/list-params.ts` the same way, carrying `kind` (defaulting to `'SONG'`) and `search`.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/music.ts "src/app/(app)/music/requests/list-params.ts" "src/app/(app)/music/maintenance/list-params.ts" tests/unit/music-merge-schema.test.ts
git commit -m "feat(music): the merge and request contracts, refused at the form as well as the door"
```

---

## Task 7: The service layer

**Files:**
- Modify: `src/services/music.ts`
- Modify: `src/app/(app)/music/errors.ts`

**Interfaces:**
- Consumes: the schemas from Task 6, the RPCs from Tasks 2–4.
- Produces:
  - `listMusicRequestsPage(params: RequestListParams): Promise<RequestListPage>` where `RequestSummary = { requestId, memberId, memberName, memberPhone, songId, songTitle, songArchived, artistName, showId, showName, channel, requestedAt }`
  - `createMusicRequest(input, accessToken): Promise<string>`
  - `archiveMusicRequest(requestId, accessToken): Promise<void>`
  - `searchSongs(companyId, term, accessToken): Promise<SongOption[]>` where `SongOption = { songId, title, artistName }`
  - `listMergeCandidates(companyId, kind, search, accessToken): Promise<MergeCandidate[]>` where `MergeCandidate = { id, label, subLabel, childCount, legacyId }`
  - `mergeMusicRecords(input: MergeFormInput, accessToken): Promise<number>`

- [ ] **Step 1: Add the RPC-name map and the merge call**

The five doors take identical arguments, so one map keeps the kind from reaching the client as a string:

```ts
/** The one place a merge kind becomes an RPC name — mirrors 0105's music_merge_table, so a caller's kind can never reach the wire as a raw string. */
const MERGE_DOORS: Record<MusicMergeKind, 'merge_songs' | 'merge_artists' | 'merge_record_labels' | 'merge_music_genres' | 'merge_shows'> = {
  SONG: 'merge_songs',
  ARTIST: 'merge_artists',
  LABEL: 'merge_record_labels',
  GENRE: 'merge_music_genres',
  SHOW: 'merge_shows',
};

/**
 * Collapses duplicates into a survivor and returns how many children moved.
 *
 * The count is returned rather than discarded because it is the only feedback
 * the operator gets that the merge did what they meant: "3 requests moved" and
 * "0 requests moved" are the difference between having merged the right pair
 * and having merged two rows nobody had used, and the screen says which.
 */
export async function mergeMusicRecords(
  input: MergeFormInput,
  accessToken: string,
): Promise<number> {
  const { data, error } = await asCaller(accessToken).rpc(MERGE_DOORS[input.kind], {
    p_winner_id: input.winnerId,
    p_loser_ids: input.loserIds,
    p_reason: input.reason,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'number') throw new InternalError('the merge returned no count');
  return data;
}
```

- [ ] **Step 2: Add the request reads and writes**

`listMusicRequestsPage` calls the RPC rather than PostgREST — the keyset and the identity rules are not expressible over an embed, which is the same reason `listParticipationsPage` is an RPC call. Follow that function's shape in `src/services/participations.ts`: pass the cursor apart, take `REQUEST_PAGE_SIZE + 1` rows, reverse when walking back, and read `total_count` off the first row (it is the same on every row).

```ts
/** The same number the Songs and Artists lists use: what a person can scan. */
export const REQUEST_PAGE_SIZE = 50;
```

`createMusicRequest` sends `p_requested_at` only when the form gave one — `coalesce(p_requested_at, now())` in 0107 means omitting the key and sending null are the same, and omitting it is the one that survives a future change to the default.

- [ ] **Step 3: Extend the error taxonomy**

`mapMusicError` already maps `P0002 → NotFoundError` and `42501 → UnauthorizedError`, which is every code the new RPCs raise except `XX000`. Leave the mapping alone and extend its doc comment to name the new sources:

```
 * - `P0002` now also covers: a merge naming a record that is missing,
 *   already archived or in another Station (0106 answers all three
 *   identically on purpose — a distinct message would let a caller probe
 *   another Station), and a request naming a listener not linked to this
 *   Station, a song that is not live here, or a programme that is not.
```

In `src/app/(app)/music/errors.ts`, `describeMusicWriteError`'s `NotFoundError` branch currently says "That could not be found. Refresh the page and try again." That is right for a stale record dialog and wrong for a merge, where the honest sentence names what happened. Add a dedicated function rather than widening the shared one:

```ts
/**
 * A merge's own refusals. Separate from describeMusicWriteError because its
 * NotFoundError sentence ("refresh and try again") is right for a stale record
 * dialog and misleading here: a merge's P0002 means one of the records the
 * operator ticked is gone, archived, or — deliberately indistinguishable — in
 * another Station, and "refresh the page" is the correct advice for only the
 * first of those.
 */
export function describeMergeError(cause: unknown): string {
  if (cause instanceof NotFoundError) {
    return 'One of the records you selected is no longer available — it may have been archived or merged by somebody else. Refresh the list and start again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to merge records in this Station.';
  }
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof ConflictError) return cause.message;
  return 'Could not merge. Refresh the page and try again.';
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/services/music.ts "src/app/(app)/music/errors.ts"
git commit -m "feat(music): the service layer for requests and merging"
```

---

## Task 8: The Requests screen

**Files:**
- Create: `src/app/(app)/music/requests/page.tsx`, `requests-filters.tsx`, `requests-grid.tsx`, `record-request-form.tsx`, `actions.ts`

**Interfaces:**
- Consumes: `listMusicRequestsPage`, `createMusicRequest`, `archiveMusicRequest`, `searchSongs`, `listMusicReferences` (for the show filter), `searchStationListeners` and `resolveOrCreateMember` (from `@/services/participations`), `getMusicPermissions`, `listCompanyAccess`, `stationSwitchHref`.

- [ ] **Step 1: Copy the page's skeleton from the Songs screen**

`src/app/(app)/music/songs/page.tsx` is the model: `createUserClient`, `listCompanyAccess(supabase, 'music.view', stationSearch)`, the `capped`/`suspended`/`NoStationMatch` handling, `viewable.find(...) ?? first`, the `Promise.all` of the list read and `getMusicPermissions`, and the `LoadError` fallback through `describeMusicReadError`.

**The switcher link goes through `stationSwitchHref('/music/requests', company.id, stationSearch)`** — `tests/unit/station-switch.test.ts` fails the day it does not.

- [ ] **Step 2: The grid**

Columns: listener, song, artist, programme, channel, when. Two states the other grids do not have:

- **A listener column that is null.** The caller holds `music.view` and not `members.view`. Render "—" with a `title` explaining it, never a blank cell that reads as missing data.
- **An archived song.** `songArchived` is true; render the title with a muted "archived" badge beside it. The row is history and stays legible.

- [ ] **Step 3: The manual-entry form**

`record-request-form.tsx` is a client component in the shape of `src/app/(app)/participations/record-participation-form.tsx` — read it first. Two halves:

1. **The listener.** A search box calling a Server Action wrapping `searchStationListeners`, a result list to pick from, and — when nothing matches — the fields to register one (`fullName` plus at least one identifier). Picking sets `memberId`; registering leaves it empty and sends the fields.
2. **The song.** A search box calling a Server Action wrapping `searchSongs`, showing `title — artistName`. Plus an optional programme `<select>` fed by `listMusicReferences(companyId, 'SHOW')`, and an optional date.

Rendered only when `permissions.request` is true. That is a courtesy: 0107 re-checks `music.request` in its own body regardless.

- [ ] **Step 4: The actions**

`actions.ts` carries `'use server'` and two actions. Each: read the access token, parse with the Zod schema, call the service, `revalidatePath('/music/requests')`, and return `{ ok: false, message: describeMusicWriteError(cause, 'record a request') }` on failure.

The record action resolves the listener first when `memberId` is absent:

```ts
// Block 3's deduplication, reused rather than re-implemented: the same
// function the participations form calls, so the two doors into a listener
// cannot drift. `elsewhere` is not an error and not a registration — an
// identifier matches somebody this caller may not reach — and the request
// simply cannot be recorded against them.
const resolved = await resolveOrCreateMember({ ... }, accessToken);
if (resolved.outcome === 'elsewhere') {
  return { ok: false, message: 'That listener is registered at a Station you cannot reach. Ask somebody who can.' };
}
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm run build && npm test`
Expected: all green, including the source-shape test in `tests/unit/station-switch.test.ts` now covering a ninth screen.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/music/requests"
git commit -m "feat(music): the Requests screen, and a manual entry that finds its listener"
```

---

## Task 9: The Maintenance screen

**Files:**
- Create: `src/app/(app)/music/maintenance/page.tsx`, `merge-panel.tsx`, `actions.ts`

**Interfaces:**
- Consumes: `listMergeCandidates`, `mergeMusicRecords`, `getMusicPermissions`, `listCompanyAccess`, `stationSwitchHref`, `describeMergeError`.

- [ ] **Step 1: The page**

Same skeleton as Task 8, resolving the Station on `'music.view'` and reading `listMergeCandidates` for the current `kind`. If `permissions.merge` is false, render the list read-only with an explanation rather than redirecting — the operator can see the duplicates and learn they need the permission, which is more useful than a bounce to `/app`.

Five tabs (Songs, Artists, Labels, Genres, Shows) writing `?kind=`, each preserving `companyId` and `station` — the same cross-preservation gap `docs/block-7a-report.md` §8 records for the Catalog screen's tabs. **Do not repeat it here:** the tab link spreads the whole current state, not just `kind`.

- [ ] **Step 2: The panel**

`merge-panel.tsx` is a client component:

- a search box narrowing the candidate list;
- a checkbox per row, showing `label`, `subLabel` and **`childCount`** — "412 requests" is what tells the operator which of two identical titles is the real one;
- a staging area listing the ticked rows, with a radio to name the survivor and a remove button per row;
- a required reason field (`MERGE_REASON_MAX_LENGTH`);
- a submit button, disabled until at least one loser is staged and a survivor is named.

**The staging area is React state and nothing else** (§5.1). It disappears if the operator leaves. Persisting a merge basket across sessions would be a table and a synchronisation problem for a flow that lasts a minute.

Before submitting, a confirmation step naming exactly what will happen: *"Merge 2 records into «Sozinho»? 412 requests will move. This cannot be undone."* The merge is irreversible and the button is small.

- [ ] **Step 3: The action**

```ts
const result = mergeFormSchema.safeParse({ ... });
// ...
const moved = await mergeMusicRecords(result.data, accessToken);
revalidatePath('/music/maintenance');
// The count is the receipt. "0 records moved" is a legitimate outcome — two
// duplicates nobody had used yet — and saying so is more honest than a
// generic "Merged.", which would read identically after a merge that silently
// did nothing.
return { ok: true, message: `Merged. ${moved} record(s) moved to the surviving entry.` };
```

Failures go through `describeMergeError`, not `describeMusicWriteError` — see Task 7 Step 3 for why.

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/music/maintenance"
git commit -m "feat(music): the Maintenance screen, where a duplicate finally gets collapsed"
```

---

## Task 10: The navigation, and the round trip

**Files:**
- Modify: `src/lib/auth/shell.ts`
- Create: `tests/e2e/music-requests.spec.ts`

- [ ] **Step 1: Add the two nav items**

In `src/lib/auth/shell.ts`, extend the Music section:

```ts
      items: [
        { href: '/music/songs', label: 'Songs', icon: ICONS.music },
        { href: '/music/artists', label: 'Artists', icon: ICONS.users },
        { href: '/music/catalog', label: 'Catalog', icon: ICONS.box },
        { href: '/music/requests', label: 'Requests', icon: ICONS.ticket },
        // Last in the section on purpose: it is the destructive one, and a
        // sidebar is read top to bottom. Every other Music item is a place to
        // build; this is the only place to collapse.
        { href: '/music/maintenance', label: 'Maintenance', icon: ICONS.shield },
      ],
```

Check `ICONS` in `src/components/layout/app-shell.tsx` for the names actually declared — `ticket` and `shield` are used elsewhere in this file, but confirm rather than assume, and follow the existing comment's rule about two adjacent rows never sharing an icon.

- [ ] **Step 2: Write the e2e round trip**

`tests/e2e/music-requests.spec.ts`, modelled on `tests/e2e/music-catalogue.spec.ts`:

1. sign in, reach `/music/songs`, register an artist and two songs with the same title;
2. reach `/music/requests`, record a request against the second song for a new listener;
3. confirm the request lists;
4. reach `/music/maintenance`, tick both songs, name the first as the survivor, give a reason, merge;
5. return to `/music/requests` and confirm the request is there, now naming the surviving song;
6. return to `/music/songs` and confirm only one of the two titles remains.

Step 5 is the whole point. A test that stopped at step 4 would pass over a merge that archived the loser and forgot to move anything.

- [ ] **Step 3: Run the gates**

Run: `npm run lint && npm run typecheck && npm run build && npm test && npm run db:test`
Then: `npm run test:isolation` and `npm run test:e2e`.

Report exactly what each says. Both isolation and e2e carry pre-existing environment failures (`docs/block-7a-report.md` §1.1–1.2). **Failures that match those descriptions are reported as environment findings; anything else is this block's and must be fixed.**

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth/shell.ts tests/e2e/music-requests.spec.ts
git commit -m "feat(music): the two new doors in the sidebar, and the round trip that proves the merge"
```

---

## Task 11: The report and the runbook

**Files:**
- Create: `docs/block-7b-report.md`, `docs/block-7b-runbook.md`

- [ ] **Step 1: Write the report**

Follow `docs/block-7a-report.md`'s structure: the gates with real numbers and honest non-green sections; what shipped; what the plan got wrong and execution found; what is knowingly missing; deferred minors.

**Four things this block must record whether or not anybody asks:**

1. **A merged loser keeps its `legacy_id`, and the index does not filter `deleted_at`.** `songs_legacy_unique` is `(company_id, legacy_id) where legacy_id is not null` — an archived loser still occupies its handle. That is *correct* for idempotency (a second ETL run must not recreate a duplicate that was just merged) and it means **Block 9's lookup has to include archived rows**, or the import will hit `23505` and read it as a fault. Neither this block nor 0098 says so anywhere yet.
2. **`children_moved = 0` is legitimate**, and both the screen and the history row say so plainly rather than implying failure.
3. **Whether the `test:isolation` and `test:e2e` environment failures reproduced**, described exactly, with no inherited claim from 7a's report.
4. **The mutation result from Task 2 Step 5** — which assertions failed when the repoint was commented out. That is the evidence the tests would catch the one defect §6 names.

- [ ] **Step 2: Write the runbook**

Follow `docs/block-7a-runbook.md`. It must open with the trap 7a paid for:

> **The database and the frontend deploy separately.** `has_permission`'s first line requires the permission code to exist in `public.permissions`. `music.request` and `music.merge` shipped in 0098, so they are already there — but the five merge doors, the three request functions and `list_merge_candidates` are not, and a frontend deployed ahead of `supabase db push` will show both screens and fail every action on them with a message that does not look like a deploy problem.

Then: apply `0105`–`0108`, verify each function exists and its grants, assign `music.request` and `music.merge` to the roles that should have them (they have been assignable since 7a at zero capability — **the day this ships, every role already holding either code acquires a real one**), and walk the round trip.

- [ ] **Step 3: Commit**

```bash
git add docs/block-7b-report.md docs/block-7b-runbook.md
git commit -m "docs: what Block 7b built, what it decided, and what Block 9 inherits"
```

---

## Self-review — spec coverage

| spec requirement | task |
|---|---|
| D1 — every table per Station | inherited from 0098; `music_merges` carries both ids (Task 1) |
| D2 — a duplicate is allowed and fixed afterwards | Tasks 2, 4, 9 |
| D3 — merging moves the children, all four entities | Task 2 — **five**, per the owner's 2026-08-04 ruling |
| D4 — many losers at once, atomic | Task 2 (`p_loser_ids uuid[]`, one transaction, assertion 14) |
| D5 — a request names a listener, and has no state | Tasks 3, 6, 8 |
| D6 — the listener's identity rules | Task 3 (RULES 1–3), Task 5 (proved with real grants) |
| D7 — `legacy_id` | inherited from 0098; the merge's consequence for it is recorded in Task 11 |
| D8 — four permissions, the destructive one separate | Task 2 (`music.merge`), Task 3 (`music.request`), Task 5 case 1 |
| §3.4 — `music_merges` | Task 1 |
| §4 — one private core, public doors, six behaviours | Task 2 |
| §5 — the Requests and Maintenance screens | Tasks 8, 9, 10 |
| §5.1 — the staging area lives on the screen | Task 9 Step 2 |
| §6 — the merge moves the children | Task 2 assertions 17–19, and the mutation in Step 5 |
| §6 — a cross-Station merge is refused, in the isolation suite | Task 5 cases 3 and 4 |
| §6 — the loser leaves the lists and its history survives | Task 2 assertions 20–21 |
| §6 — the merge is atomic, proved by mutation | Task 2 assertions 14–16 |
| §6 — `music.view` without `members.view` | Task 5 cases 6 and 7 |
| §8 — what Block 9 inherits | Task 11 Step 1, items 1 and 2 |

**Not in this plan, and deliberately:** the Music dashboard (Block 8), the legacy ETL (Block 9), the WhatsApp music-request flow (its own block, position the owner's to set), and the listener merge ruled for on 2026-08-01 — which should reuse `apply_music_merge`'s shape when it is built.
