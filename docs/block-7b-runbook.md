# Block 7b — Requests and the First Merge

**Audience:** whoever deploys this block, and whoever operates a Station
once it is live — including whoever eventually builds Block 9's import
against the catalogue this block can now merge.

---

## 1. The trap: the database and the frontend deploy separately

**Read this before running anything.** `docs/block-7a-report.md`'s runbook
paid for this once already; it applies again here, against a different set
of functions.

`public.has_permission(p_permission text, p_company_id uuid)` — the gate
every RPC in this block calls before doing anything else — begins:

```sql
select exists (select 1 from public.permissions p where p.code = p_permission)
   and public.has_company_access(p_company_id)
   and ( ... )
```

Its **first** condition requires the permission code to already exist as a
row in `public.permissions`. `music.request` and `music.merge` were inserted
by `0098_music_catalogue.sql` — Block 7a — so they are already live in
`public.permissions` today, in every environment 7a has reached. That part
is not this deploy's problem.

**What is this deploy's problem:** the nine functions those two permission
codes are meant to gate — `merge_songs`, `merge_artists`,
`merge_record_labels`, `merge_music_genres`, `merge_shows`,
`create_music_request`, `archive_music_request`, `list_music_requests`, and
`list_merge_candidates` — do not exist until migrations `0105`–`0108` are
applied. If the frontend for this block (the Requests and Maintenance
screens, both already in `src/lib/auth/shell.ts`'s Music section on this
branch) reaches production ahead of `supabase db push`, both screens will
**render** — the sidebar has no permission gate, by the same "hiding a link
is a courtesy" convention every earlier block uses — and **every action on
them will fail** with `PGRST202` ("Could not find the function ... in the
schema cache") or an equivalent "function does not exist" fault. That
message does not mention a migration, a deploy order, or anything an
on-call engineer would recognise as "the database is behind" — it reads
exactly like a fresh code defect, and the natural first instinct (check the
frontend code, check the RPC call site) leads nowhere, because there is
nothing wrong there. Push the database first.

**The other direction is silent, not loud, and worse to miss:** pushing
`0105`–`0108` alone, with no frontend change, changes nothing an operator
can see — no sidebar link exists yet to reach the new screens. But it does
mean the nine functions now exist and are gated only on `music.request` /
`music.merge`, which — see the note at the end of §2 — every role that has
held either permission since 7a can now actually use, with no code deploy
required on this app's side at all. If a role was granted `music.request`
or `music.merge` months ago "at zero cost, for later," that role's holder
can call these functions directly (via `supabase-js`, `curl`, or any REST
client hitting PostgREST) the moment the migrations land, whether or not the
UI that is meant to front them has shipped.

---

## 2. Deploying this block, step by step

1. **Apply the migrations.** `supabase db push` (or your platform's
   equivalent) against `0105_music_merges.sql` through
   `0108_list_merge_candidates.sql`. Nothing else in this block touches the
   database.

2. **Verify each function exists, with the grants this block expects.** Run
   this against the target database (adjust the connection as your platform
   requires; the query itself is what was run to verify this report's own
   local instance):

   ```sql
   select p.proname,
          pg_get_function_identity_arguments(p.oid) as args,
          p.prosecdef as security_definer,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'apply_music_merge', 'music_merge_table',
        'merge_songs', 'merge_artists', 'merge_record_labels',
        'merge_music_genres', 'merge_shows',
        'create_music_request', 'archive_music_request', 'list_music_requests',
        'list_merge_candidates'
      )
    order by p.proname;
   ```

   Expect eleven rows. `apply_music_merge` and `music_merge_table` —
   `security_definer = f`, `authenticated_can_execute = f`: this is
   correct, they are the private core, callable only from inside the five
   `SECURITY DEFINER` doors. The other nine —
   `security_definer = t`, `authenticated_can_execute = t`. If any of the
   nine shows `f` for `authenticated_can_execute`, the migration that grants
   it did not apply cleanly; do not proceed to step 3 until this query
   returns exactly this shape.

3. **Assign `music.request` and `music.merge` to the roles that should have
   them.** Both codes have been assignable in the role editor since Block
   7a, at zero capability. **Nothing about assigning them changes today** —
   this step is unchanged from whatever your organisation already decided
   when 7a shipped. What changes is what those codes *do* once step 1 has
   run: see the note below.

4. **Walk the round trip once**, as an operator holding
   `music.view`, `music.request` and `music.merge` at one Station:
   - **Music → Requests** — record a manual request against an existing
     song and a real listener (search or register one inline); confirm it
     appears in the list with the song's title and the listener's name
     visible.
   - **Music → Maintenance** — pick a kind with at least two candidates
     (or create a deliberate duplicate on Songs first), tick two, name a
     survivor, give a reason, merge. Confirm the confirmation dialog names
     the real numbers, the receipt reads "Merged. N record(s) moved…", and
     the loser disappears from its own screen (Songs/Artists/Catalog)
     while the request from the previous step, if it named the loser,
     still lists and now shows no "archived" badge.
   - If any of these four screens fails with a "function does not exist" or
     `PGRST202`-shaped error, stop and re-check step 2 before assuming a
     code defect.

**The capability this deploy actually grants, stated plainly:** the day
`0105`–`0108` reach an environment, **every role already holding
`music.request` or `music.merge` in that environment acquires a real,
usable capability it has had at zero cost since 7a.** This is not a new
grant anyone has to make — it is the existing grant becoming load-bearing.
If a role was given `music.merge` casually, as a courtesy, or by copying an
owner's permission set without thinking about what it would eventually mean,
this is the moment that decision starts to matter: that role can now
irreversibly collapse duplicate records. Audit who holds `music.merge`
**before** this deploy reaches an environment an operator can act in, not
after.

---

## 3. Where the new screens live

**Music → Requests**, `/music/requests` — every request an operator has
recorded by hand (and, once a later block ships it, every request the
WhatsApp flow records), filterable by song, show and channel, with a
manual-entry form that finds or registers the listener inline.

**Music → Maintenance**, `/music/maintenance` — one kind at a time (Songs,
Artists, Labels, Genres, Shows), filtered, ticked into a staging area, one
survivor named, a mandatory reason, and a merge button. The staging area
lives on the screen only — it is gone the moment the operator navigates
away without merging, by design (§5.1 of the design spec).

Both sit in the Music section of the sidebar, after Songs/Artists/Catalog,
in that order — Requests before Maintenance, on the reasoning (recorded in
`src/lib/auth/shell.ts`) that a sidebar read top to bottom should put the
one destructive, irreversible screen in this section after everything that
builds or records into it. Like every other screen in this section, the
link itself is visible to anyone; the boundary is enforced underneath, on
opening the page and on every write.

---

## 4. Which permission unlocks what, now that this block has shipped

```sql
select code, module, label from public.permissions where module = 'music' order by display_order;
```

Still the same four rows 7a's runbook records — this block adds no new
permission code, only doors behind two that shipped inert:

| code | module | label |
|---|---|---|
| `music.view` | music | See the music catalogue |
| `music.manage` | music | Register and edit the catalogue |
| `music.request` | music | Record a music request |
| `music.merge` | music | Merge duplicated records |

| Permission | Unlocks, as of this block |
|---|---|
| `music.view` | Everything it unlocked in 7a, **plus**: opens `/music/requests` (read-only if `music.request` is absent — the manual-entry form is hidden but the list still loads) and `/music/maintenance` in **read-only mode** — an operator can search and see which records are duplicated, with no checkboxes, no staging area, and no merge button, only a banner explaining `music.merge` is required to act. This last part is deliberate and load-bearing (§6 of the verification report): `list_merge_candidates` is gated on `music.view`, not `music.merge`, specifically so this read-only mode is reachable at all. |
| `music.manage` | Unchanged from 7a — register, edit and archive the catalogue. Holding it does **not**, by itself, unlock reading the Maintenance candidate list or recording a request; both of those are gated on `music.view`/`music.request` respectively, proven directly with a live Postgres role in `tests/isolation/music-merge.test.ts`. |
| `music.request` | **Now does something.** Unlocks the manual-entry form on the Requests screen (`create_music_request`) and the withdraw action on a mistyped entry (`archive_music_request`). |
| `music.merge` | **Now does something, and it is the one operation in this whole domain that destroys data.** Unlocks the staging area, the reason field and the merge button on the Maintenance screen for all five kinds. Every merge is checked again inside the database on every call — a role holding it in the UI carries no more weight than the database is willing to honour, the same standing rule 7a's runbook states for `music.manage`. |

---

## 5. The legacy handle after a merge — read this before Block 9 is built

A merge never deletes a row; it soft-deletes the loser
(`deleted_at = now()`) and **never touches its `legacy_id`**. The unique
index that makes `legacy_id` mean anything —

```sql
create unique index songs_legacy_unique on public.songs (company_id, legacy_id) where legacy_id is not null;
```

— carries no `deleted_at is null` predicate, on every one of the six
tables that has one. **An archived loser still occupies its `legacy_id`
slot.** This is intentional: it is what lets a second ETL run recognise a
row it already imported and later got merged away, instead of quietly
resurrecting the exact duplicate the merge just fixed.

**The consequence for whoever builds Block 9's importer:** any
"have I already imported this `legacy_id`?" lookup must include archived
rows. A lookup that goes through the ordinary `select` path (RLS,
`authenticated`, or the anon/service-role paths this codebase already uses
elsewhere) will never see an archived row — 0099's policies filter
`deleted_at is null` inside the policy itself, not as an application-level
choice the importer can opt out of. An importer that only ever sees "not
found" for an archived handle will `insert` a second row and either collide
on `23505` against the *winner's* handle (rare — the winner has a different
`legacy_id`) or, far more commonly, simply succeed and duplicate a record
this block's own merge tool had already fixed, with nothing anywhere
raising an error to say so. Reading a genuine `23505` collision as an ETL
fault, rather than as "this row was already imported and later merged
away, so the collision is correct," is the specific mistake this section
exists to prevent. Nothing in `0098` or this block's own migration comments
says this anywhere else the way this runbook does — the ETL's own lookup
needs to query past `deleted_at`, inside a definer body or with
`service_role` reading directly against the table, not through the ordinary
policy-filtered path every screen in this codebase uses.

---

## 6. Zero children moved is a successful merge, not a failed one

Two duplicates that no request had ever pointed at merge cleanly with
`children_moved = 0`. This is not an error state and nothing treats it as
one: the confirmation receipt reads "Merged. 0 record(s) moved…" using the
same correctly-pluralised counter as any other number, and the history row
in `music_merges` carries `children_moved = 0` as a plain, valid fact —
the column's own comment in `0105_music_merges.sql` states this directly:
*"Zero is a legitimate value — a duplicate nobody had used yet."* If an
operator or a support ticket reports "the merge said zero records moved,
did it work?" — yes. It moved the zero that existed to move.

---

## 7. Refusals you may meet

| Message on screen | Cause |
|---|---|
| *"You do not have permission to merge records in this Station."* | `music.merge` is missing for the selected Station — check the role assigned there, not the account overall. |
| *"One of the records you selected is no longer available — it may have been archived or merged by somebody else. Refresh the list and start again."* | The merge's own `P0002` — a ticked candidate was archived, merged, or (deliberately indistinguishable, by design) belongs to another Station, between the moment it was listed and the moment the merge ran. |
| *"That could not be found. Refresh the page and try again."* | `create_music_request`'s `P0002` — the listener, song or programme named no longer resolves at this Station (soft-deleted, or an id that never existed here). |
| *"You do not have permission to \[record a request / withdraw this request\] in this Station."* | `music.request` is missing for the selected Station. |
| A request still lists, with no "archived" badge, after a merge | This is the **success** case, not a refusal — it means the song the request names survived the merge (as the winner) or was repointed to the winner. The badge appears only when a request's song is still soft-deleted, which is the failure mode a working merge prevents. |
| The Maintenance screen shows candidates but no checkboxes, staging area or merge button, with a banner about `music.merge` | `music.view` is present but `music.merge` is not — the screen's own read-only mode (§4), not a bug. |
| The page redirects away, or the screen never loads | `music.view` is missing for the selected Station. |
| A generic "could not load" / "could not save" / "could not merge" sentence, with no specific reason named | An unexpected fault, not a refusal — worth reporting rather than retrying blindly. |

---

## 8. What is not here yet

- **A WhatsApp-recorded request.** `music_requests.channel` still only ever
  holds `MANUAL` from this block's own door; `WHATSAPP` is a future block's
  one-line enum migration, and nothing here writes it.
- **The listener merge** ruled for on 2026-08-01. This block's core
  (`apply_music_merge`'s locking order, atomicity, and
  permission-before-existence shape) is the shape it should reuse — nothing
  here builds it.
- **Any dashboard reading `music_requests` or `music_merges`.** Block 8's,
  whole.
- **An "include archived" toggle on Requests or Maintenance.** Neither
  screen offers a way to see a withdrawn request or an already-merged
  loser; both read past `deleted_at` only inside their own `SECURITY
  DEFINER` bodies, with no UI surface exposing that filter.
