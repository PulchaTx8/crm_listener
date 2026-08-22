# P1 — the suspended Station stops registering listeners: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A promotion hashtag sent to a suspended Station or a blocked
Organization must register nobody, record no participation and enqueue no reply.

**Architecture:** `ingest_whatsapp_event` already computes `v_tenant_live` — the
three-column liveness of the Station and its Organization — before it matches the
hashtag, and today uses it in one place only, far downstream on the fast path.
The MUSIC and MENU hashtags are already safe because they can only match through
`v_install`, whose select joins `companies` and `organizations` on those same
three columns. The PROMOTION hashtag is not, because its select reads
`public.promotions` directly by `company_id`. This adds one gate, immediately
after the payload-integrity raises and before the first hashtag select, so all
three hashtags answer the same thing at a dead tenant.

**Tech Stack:** PostgreSQL / PL/pgSQL, Supabase migrations, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-22-station-root-and-platform-identity-design.md`
— block **P1** of §11, decision **D9**.

## Global Constraints

- **Everything in English** — identifiers, comments, error messages, docs, commit
  messages. The conversation that produced this plan was in Portuguese; nothing
  written to the repository is.
- **Never edit a merged migration in place.** `0267` and `0058` stay exactly as
  they are, including the comments this change makes historical. Corrections are
  re-issued from the new migration.
- **Copy the function body forward from the LIVE definition**, which is
  `supabase/migrations/0267_whatsapp_fast_entry.sql:317-931`. Copying from `0062`,
  `0070` or `0179` would silently revert every fix made since.
- **New migration number: `0271`.** The highest on `main` is `0270_promotions_geography.sql`.
- **Run `npm run db:reset` before `npm run db:test`.** The e2e and isolation
  suites leave the local database dirty and produce two false reds otherwise.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/tests/06_whatsapp.test.sql` (modify) | Where the bot's door is pinned. Gains one fixture-and-assert section and a raised `plan()` count. It already carries `pg_temp.ingest(...)`, the helper every ingest assertion in the file drives the door through. |
| `supabase/migrations/0271_suspended_station_gate.sql` (create) | Re-creates `ingest_whatsapp_event` with the gate added, and re-issues the two comments the gate makes false. |

**No TypeScript changes.** `src/services/whatsapp.ts:268` special-cases only
`link` and `no_hashtag`; every other outcome falls to one branch that treats the
event as already finished by the function. A new outcome value flows through
untouched.

**No isolation-suite changes.** `tests/isolation/whatsapp.test.ts` proves tenant
isolation of reads. This is a gate inside a `SECURITY DEFINER` function, which is
what the pgTAP suite exists to pin.

---

### Task 1: Prove the hole

The test must fail against `main` before anything is fixed. If it passes, the
premise is wrong and the rest of this plan must not be executed.

**Files:**
- Test: `supabase/tests/06_whatsapp.test.sql`

**Interfaces:**
- Consumes: `pg_temp.ingest(p_wamid text, p_from text, p_text text, p_at timestamptz, p_number text default '111111111111111') returns jsonb` — already defined in this file at line 936. It inserts a `webhook_events` row, calls `public.ingest_whatsapp_event`, catches any raise into `outcome = 'RAISED <sqlstate>: <message>'`, and returns the result JSON.
- Consumes: `pg_temp.confirmation(p_wamid text) returns public.outbox_messages` — already defined in this file, finds the outbox row by the `'<sha256 of wamid>:confirmation'` dedupe key.
- Consumes fixtures already in this file: Station `00000000-0000-0000-0000-0000000005c2`, Organization `00000000-0000-0000-0000-0000000005f1`, and the live promotion `#EUQUERO` (`00000000-0000-0000-0000-000000000591`, window `2026-06-01Z` to `2026-06-30Z`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Raise the plan count**

`supabase/tests/06_whatsapp.test.sql` line 2 reads `select plan(147);`. This task
adds seven assertions.

```sql
select plan(154);
```

- [ ] **Step 2: Append the failing section at the end of the file, immediately before `select * from finish();`**

Placed at the end deliberately: it mutates `companies.status` and
`organizations.suspended_at`, and every earlier assertion in this file depends on
that Station being live. It restores both before its last two assertions, which
is also what proves the gate — and not some unrelated fixture — is the cause.

```sql
-- ---------------------------------------------------------------------------
-- P1. A DEAD TENANT REGISTERS NOBODY.
--
-- Until 0271 the promotion hashtag reached the listener resolution and the
-- pre-check with no liveness test of any kind: v_install's join carries
-- c.deleted_at, c.status and o.suspended_at, and MUSIC and MENU cannot match
-- without it, but the promotion select reads public.promotions straight off
-- company_id. So a Station suspended for non-payment went on registering
-- listeners, recording participations and enqueueing replies that Meta bills it
-- for -- 0267's own comment names this and says it is not closed there.
--
-- The phones below are new to this file, so a member appearing under either one
-- can only have been created by the call under test.
-- ---------------------------------------------------------------------------

update public.companies
   set status = 'suspended'
 where id = '00000000-0000-0000-0000-0000000005c2';

select is(
  pg_temp.ingest('wamid.P1SUSPENDED', '5511977770001', 'quero #EUQUERO',
                 '2026-06-10T12:00:00Z') ->> 'outcome',
  'tenant_inactive',
  'a promotion hashtag at a SUSPENDED Station finishes tenant_inactive');

select is(
  (select count(*)::int from public.members
    where phone_normalized like '%977770001'),
  0,
  'and registers no listener');

select is(
  (select count(*)::int from public.participations p
    join public.members m on m.id = p.member_id
   where m.phone_normalized like '%977770001'),
  0,
  'and records no participation');

select is(
  (select count(*)::int from pg_temp.confirmation('wamid.P1SUSPENDED')),
  0,
  'and enqueues nothing for Meta to bill the Station for');

update public.companies
   set status = 'active'
 where id = '00000000-0000-0000-0000-0000000005c2';

update public.organizations
   set suspended_at = now()
 where id = '00000000-0000-0000-0000-0000000005f1';

select is(
  pg_temp.ingest('wamid.P1BLOCKEDORG', '5511977770002', 'quero #EUQUERO',
                 '2026-06-10T12:00:00Z') ->> 'outcome',
  'tenant_inactive',
  'a promotion hashtag at a BLOCKED Organization finishes tenant_inactive too');

select is(
  (select count(*)::int from public.members
    where phone_normalized like '%977770002'),
  0,
  'and registers no listener either');

-- THE CONTROL, and the reason both updates above are undone. Without it, a
-- fixture broken for some unrelated reason would make all six assertions above
-- pass while proving nothing.
update public.organizations
   set suspended_at = null
 where id = '00000000-0000-0000-0000-0000000005f1';

select isnt(
  pg_temp.ingest('wamid.P1LIVEAGAIN', '5511977770003', 'quero #EUQUERO',
                 '2026-06-10T12:00:00Z') ->> 'outcome',
  'tenant_inactive',
  'and the very same message at the restored Station is not refused');
```

- [ ] **Step 3: Run the suite and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: `06_whatsapp` fails. The first assertion reports
`have: recorded` (or `link`) `want: tenant_inactive`, and the three assertions
under it report `have: 1  want: 0` — the listener, the participation and the
outbox row that should not exist. The last assertion passes already.

If instead the first assertion reports `have: tenant_inactive`, the hole is
already closed and this plan is obsolete. Stop and report that.

- [ ] **Step 4: Commit the failing test**

```bash
git add supabase/tests/06_whatsapp.test.sql
git commit -m "test(p1): the suspended Station that still registers listeners, pinned red"
```

---

### Task 2: Close it

**Files:**
- Create: `supabase/migrations/0271_suspended_station_gate.sql`
- Read (do not modify): `supabase/migrations/0267_whatsapp_fast_entry.sql:317-936`

**Interfaces:**
- Consumes: `v_tenant_live boolean` — already declared at `0267:333` and assigned at `0267:460-465` from `c.deleted_at is null and c.status = 'active' and o.suspended_at is null`. Nothing new is computed.
- Consumes: `public.finish_whatsapp_event(p_event_id uuid, p_outcome text, p_status text, p_participation_id uuid) returns jsonb` — the same call the `no_promotion` branch 60 lines below already makes.
- Produces: outcome value `'tenant_inactive'` on `webhook_events.outcome`, which no other task and no TypeScript consumes.

- [ ] **Step 1: Create the migration by copying the live definition forward**

```bash
{ printf -- '-- supabase/migrations/0271_suspended_station_gate.sql\n\n'; \
  sed -n '317,937p' supabase/migrations/0267_whatsapp_fast_entry.sql; } > supabase/migrations/0271_suspended_station_gate.sql
```

That range is exactly three statements: `create or replace function
public.ingest_whatsapp_event` through its `$$;` (317-931), the two grant lines
(933-934), and the whole `comment on function` (936-937) — whose body is one
enormous single-quoted string living on line 937 alone.

Verify the copy arrived whole before editing it:

```bash
grep -c '^[$][$];' supabase/migrations/0271_suspended_station_gate.sql  # expect 1
tail -c 60 supabase/migrations/0271_suspended_station_gate.sql          # ends: minutes later.';
```

- [ ] **Step 2: Insert the gate**

In the new file, find the payload-integrity raise that ends this way (it is the
second of two, at `0267:511-515`):

```sql
  if v_when is null then
    raise log 'ingest_whatsapp_event: no timestamp on event % (wamid sha256 %)',
      v_event.id, v_event.external_id;
    raise exception 'whatsapp payload carries no message timestamp'
      using errcode = '22023';
  end if;
```

Insert immediately after its `end if;` and before the `-- D3. Three hashtags`
comment:

```sql
  -- P1. THE TENANT'S LIVENESS, TESTED ONCE, FOR ALL THREE HASHTAGS.
  --
  -- v_tenant_live was already computed above and, until this migration, was read
  -- in exactly one place: the fast path, far below. MUSIC and MENU never needed
  -- it, because neither can match without v_install, whose select joins
  -- companies and organizations on the same three columns. THE PROMOTION SELECT
  -- BELOW HAS NO SUCH JOIN -- it reads public.promotions straight off
  -- company_id -- so a suspended Station or a blocked Organization reached the
  -- listener resolution, the pre-check, apply_participation and the outbox.
  -- 0267's own comment names that hole and says it is not closed there. This is
  -- the clause it says would close it.
  --
  -- PLACED HERE rather than beside the promotion select, so a dead tenant gives
  -- ONE answer whatever hashtag arrives, instead of tenant_inactive for a
  -- promotion and no_promotion for the other two. And placed BELOW the two
  -- raises above rather than over them: a payload the route mangled is the
  -- route describing its own defect, and suspending a Station must not silence
  -- that.
  --
  -- NOT PLACED ABOVE THE no_hashtag BRANCH either. That branch deliberately
  -- leaves the event PROCESSING for a caller that may hold the conversation
  -- outside this database, and answering it from here would finish a row the
  -- caller still owns.
  --
  -- A NEW OUTCOME rather than a reused one. webhook_events.outcome is plain
  -- text with no CHECK on its values (0058), and src/services/whatsapp.ts
  -- special-cases only 'link' and 'no_hashtag'. Reusing no_promotion would have
  -- recorded, in the one column built to answer "why didn't it work?", that a
  -- promotion nobody could find was the reason -- when it is live, matching, and
  -- the Station simply is not. The listener's experience is identical either
  -- way: silence, design spec D4.
  if not coalesce(v_tenant_live, false) then
    return public.finish_whatsapp_event(v_event.id, 'tenant_inactive', null, null);
  end if;
```

- [ ] **Step 3: Correct the two comments this makes false, in the new migration only**

At the end of `0271_suspended_station_gate.sql`, two things must change. Neither
file that first wrote them may be touched.

First, inside the `comment on function public.ingest_whatsapp_event` string
copied in Step 1, find this sentence and delete it:

> Past it, and not before it: the pre-check branch and the member resolution both sit ABOVE both gates and have since 0179, so a suspended Station still records a participation, still enqueues a reply and still links a listener into a blocked Organization -- older than this block, not closed by it, and written up in the task report with the lines that would change.

Replace it with:

> 0271 closed that: the tenant''s liveness is now tested once, above all three hashtag matches, and a dead tenant finishes tenant_inactive having written nothing. Until then the pre-check branch and the member resolution sat ABOVE both gates and had since 0179, so a suspended Station recorded a participation, enqueued a reply and linked a listener into a blocked Organization.

Note the doubled apostrophe in `tenant''s` — the whole comment is one
single-quoted SQL string.

Second, append the outcome column's comment, re-issued whole:

```sql
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled, outside_window and -- since 0271 -- tenant_inactive, which is a suspended Station or a blocked Organization refusing every hashtag before anything is written or sent. All but the first are silent to the listener (design spec D4), and all of them are things somebody will eventually have to explain. "skipped" is NOT one of them: an event the door declined to take is left exactly as it was and never reaches DONE.';
```

- [ ] **Step 4: Run the suite and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `06_whatsapp` passes all 154. Every other file passes unchanged — in
particular `07_whatsapp_worker` and `08_conversation`, which drive the same door
and whose Stations are live, so the new gate is transparent to them.

If a file other than `06_whatsapp` fails, the copy in Step 1 lost something.
Diff the new function body against `0267:317-931` before changing anything else.

- [ ] **Step 5: Prove the copy reverted nothing**

The one failure mode this migration has is silent: a body copied from the wrong
generation reverts fixes and every test still passes, because the tests that
would catch it were written for behaviour the older body also had.

```bash
diff   <(sed -n '317,931p' supabase/migrations/0267_whatsapp_fast_entry.sql)   <(sed -n '/^create or replace function public.ingest_whatsapp_event/,/^[$][$];/p'         supabase/migrations/0271_suspended_station_gate.sql)
```

Expected: exactly one hunk, the inserted gate. Any other difference is
unintended and must be reverted line by line.

- [ ] **Step 6: Run the remaining gates**

```bash
npm run lint && npm run build && npm run test
```

Expected: all pass. None of them touch this function, and that is the point —
this step exists to prove the migration did not break the type generation or the
build.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0271_suspended_station_gate.sql
git commit -m "fix(p1): a suspended Station stops registering listeners and enqueueing replies"
```

---

## Closing checklist

- [ ] `npm run db:reset && npm run db:test` green from a clean database.
- [ ] The `diff` in Task 2 Step 5 shows one hunk and nothing else.
- [ ] `0267` and `0058` are untouched: `git diff main --stat` names only
      `supabase/tests/06_whatsapp.test.sql` and
      `supabase/migrations/0271_suspended_station_gate.sql`.
- [ ] **The migration is applied to the hosted database after the PR merges.**
      This project has shipped code without its migrations three times — Blocks
      13a, 17b and 17c — and the symptom is always a screen failing in production
      against a schema that never received the change.
