# Block 8a — Three Dashboards, One Period, and the Timezone That Makes Them True

**Audience:** whoever deploys this block, whoever operates a Station once it
is live, and whoever builds Block 8b's report engine on top of what this
block already counts.

---

## 0. Read this first: the trap Block 7a paid for, and this block re-arms

**The database and the frontend deploy separately.** `has_permission`'s
first line requires the permission code to exist in `public.permissions`.
`reports.consolidated` ships in `0115`, and a frontend deployed ahead of
`supabase db push` will offer the consolidated control and fail every call
behind it with a message that does not look like a deploy problem.

Concretely, if the application code for this block reaches production before
migrations `0115`–`0120` are applied:

- the sidebar's new **Dashboards** section renders regardless — the nav has
  no permission gate, on this codebase's own "hiding a link is a courtesy"
  convention, the same as every other section;
- all three pages open, because `dynamic = 'force-dynamic'` and
  `listCompanyAccess` do not depend on anything this block adds;
- and **every one of them fails the instant it tries to load real numbers**,
  with `PGRST202` ("Could not find the function `public.get_audience_dashboard`
  in the schema cache") or the equivalent for the other two — a message that
  names no migration, no deploy order, and nothing an on-call engineer would
  recognise as "the database is behind." The natural first instinct — check
  the frontend code, check the RPC call site — leads nowhere, because there
  is nothing wrong there. **Push the database first.**

The other direction is silent rather than loud, and worth stating just as
plainly: pushing `0115`–`0120` alone, with no frontend change, changes
nothing an operator can see — no sidebar link exists yet to reach the new
screens. But the moment those migrations land, `reports.consolidated`
becomes real: **any role that already holds it — assigned casually, as a
courtesy, or by copying an owner's permission set — can call the three
functions directly (via `supabase-js`, `curl`, or any REST client hitting
PostgREST) and read a consolidated total across every Station it names, with
or without a UI in front of it.** Unlike `music.request` in Block 7a, which
shipped assignable at zero capability and only acquired a real one a block
later, `reports.consolidated` is live the day `0118`–`0120` land. Audit who
holds it **before** these migrations reach an environment anyone can act in,
not after.

---

## 1. Applying the migrations

```bash
supabase db push        # hosted
# or, locally
npx supabase db reset
```

Six migrations belong to this block:

| migration | what it adds |
|---|---|
| `0115_reports_consolidated_permission.sql` | the one new permission code, `reports.consolidated` |
| `0116_dashboard_indexes.sql` | two indexes: `participations_company_period_idx`, `winners_company_created_idx` — measured gaps, not precautions (spec §6). A third, `member_links_company_linked_idx`, was in this migration's first draft and was dropped after EXPLAIN (ANALYZE) showed Postgres never chooses it (spec §6) |
| `0117_resolve_dashboard_period.sql` | `resolve_dashboard_period` — both windows, per Station, from the Station's own clock |
| `0118_audience_dashboard.sql` | `get_audience_dashboard` |
| `0119_music_dashboard.sql` | `get_music_dashboard` |
| `0120_promotions_dashboard.sql` | `get_promotions_dashboard` |

Nothing in this block edits an earlier migration in place.

---

## 2. Verify each function exists, with the grants this block expects

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'resolve_dashboard_period',
     'get_audience_dashboard', 'get_music_dashboard', 'get_promotions_dashboard'
   )
 order by p.proname;
```

Confirmed against this project's own local database while writing this
document — expect exactly these four rows, every one
`security_definer = f` (`SECURITY INVOKER`, D4 — RLS applies inside them,
nothing here restates a select policy by hand) and
`authenticated_can_execute = t`:

| proname | args | security_definer | authenticated_can_execute |
|---|---|---|---|
| `get_audience_dashboard` | `p_company_ids uuid[], p_preset text, p_from date, p_to date` | f | t |
| `get_music_dashboard` | `p_company_ids uuid[], p_preset text, p_from date, p_to date` | f | t |
| `get_promotions_dashboard` | `p_company_ids uuid[], p_preset text, p_from date, p_to date` | f | t |
| `resolve_dashboard_period` | `p_preset text, p_from date, p_to date, p_timezone text` | f | t |

If any of the four is missing, or `authenticated_can_execute` reads `f`, the
migration that grants it did not apply cleanly — do not proceed to step 3
until this query returns exactly this shape.

Also confirm the permission row itself landed:

```sql
select code, module, label, scope from public.permissions where module = 'reports' order by display_order;
```

A healthy install returns exactly one row: `reports.consolidated | reports |
See a consolidated dashboard | company`.

---

## 3. Assign `reports.consolidated` to the roles that should have it

Unlike `music.request` in Block 7a — which shipped assignable at zero
present capability and only became load-bearing a block later — **this code
is live the day it lands.** The moment step 1 has run in an environment,
every role holding `reports.consolidated` in a given Station can read a
consolidated total across every Station it also holds `reports.consolidated`
in (D3: **every** Station named, not just one).

- If you have already assigned this code to any role in anticipation of this
  block — check now, before finishing this deploy, who holds it and in which
  Stations. There is no grace period.
- The domain permission (`members.view`, `music.view`, `promotions.view`)
  still gates the panel itself; `reports.consolidated` gates only whether
  **more than one** Station may be summed into the same screen. A role
  holding a domain permission but not `reports.consolidated` sees that
  panel's own single-Station view exactly as before — the toggle simply
  never renders for them.
- Composing the role and assigning it per Station uses the same Roles/Team
  screens every earlier block's permission is granted through — nothing new
  to learn here.

---

## 4. Walk each screen at one Station, then at two

As an operator holding the relevant domain permission plus
`reports.consolidated` at (at least) two Stations:

1. **Audience → `/dashboards/audience`, one Station.** Confirm the four
   cards (Listeners at this Station, New in the period, Took part in the
   period, Listeners barred in the period), the monthly-arrivals chart, the
   barred-by-kind chart, and the two "how they were found"/"first contact"
   lists all render with real numbers for a Station carrying data. Switch
   **Previous month** and confirm the numbers change (§1.3 of the
   verification report is the exact case this proves in CI).
2. **Audience, two Stations (consolidated).** The "All stations (N)"
   control should appear only once `reports.consolidated` holds in at least
   two of the Stations you can reach with `members.view` — pick it, and
   confirm the **mixed-timezone note** appears the instant the two Stations
   do not share a timezone, and disappears again on "This station."
3. **Music → `/dashboards/music`**, same pattern: one Station, then two.
   Nothing on this panel is ever withheld (D13 does not reach `music.view`);
   every card should show a real number or a real zero, never a permission
   sentence.
4. **Promotions → `/dashboards/promotions`**, same pattern. If your test
   operator does **not** hold `participations.view`, confirm the
   participation-side figures (Participations, Distinct listeners, Why
   entries were refused, Busiest promotions, Monthly participations) each
   show an em dash and name `participations.view`, while On air now / Ended
   in the period / Prizes awarded / Overdue and uncollected / The prize
   cycle — none of which needs that permission — still show real numbers.
5. If any of these screens fails with a "function does not exist" or
   `PGRST202`-shaped error, stop and re-check §2 before assuming a code
   defect — this is exactly the deploy-order symptom §0 describes.

---

## 5. The standing check this project has now paid for twice

**After every merged PR carrying a migration, run:**

```bash
npx supabase migration list
```

and if the remote column shows any local migration missing, run
`supabase db push` before considering the deploy finished. **Nothing in
`.github/workflows/ci.yml` does this** — the `build`, `db` and `e2e` jobs all
run entirely against a local, ephemeral Postgres started fresh by
`supabase start`; none of the three ever touches the hosted project, and
none of them can therefore ever notice that the hosted database has fallen
behind.

This has already cost real time twice: the hosted database was **41
migrations behind on 2026-08-03** and **10 behind on 2026-08-05** (both per
the coordinator's own operational record). Confirmed again, freshly, while
writing this runbook — `npx supabase migration list` against this project's
linked hosted database returned every one of `0115`–`0120` with an **empty**
`remote` column:

```json
{"local":"0114","remote":"0114","time":"0114"},
{"local":"0115","remote":"","time":"0115"},
{"local":"0116","remote":"","time":"0116"},
{"local":"0117","remote":"","time":"0117"},
{"local":"0118","remote":"","time":"0118"},
{"local":"0119","remote":"","time":"0119"},
{"local":"0120","remote":"","time":"0120"}
```

Six migrations behind, right now, as this document is written — this
block's own `0115`–`0120`, not yet pushed. That is not a defect in anything
this block built; it is the exact standing gap this section exists to name,
caught by the same command it asks you to run routinely rather than only
when something is already wrong. Whoever deploys this block should run
`supabase db push` before doing anything else in §1, then re-run
`npx supabase migration list` and confirm every row's `remote` column now
matches `local`.

---

## 6. Where the new screens live

A new **Dashboards** section sits at the top of the sidebar, above
Inventory — **Audience**, **Music**, **Promotions**, at `/dashboards/audience`,
`/dashboards/music`, `/dashboards/promotions`. Like every other section in
this app, the link is visible to anyone signed in; the boundary is enforced
underneath, both by a courtesy redirect (a caller holding the panel's domain
permission in no Station at all is sent back to `/app`) and, load-bearingly,
inside the database itself.

Above each panel's cards sit two controls: the Station selector — one pill
per Station you can reach, plus, when eligible, a "This station / All
stations (N)" toggle — and the period control — Current month, Previous
month, Current year, or a free custom range. Both live entirely in the URL,
so a specific view is a link an operator can send a colleague; the period
persists correctly across a Station switch or the consolidated toggle
(verification report §5 records exactly what was, and was not, provable
about this).

---

## 7. Which permission unlocks what

| Permission | Unlocks |
|---|---|
| `members.view` | Opens `/dashboards/audience`, read-only; every card except "Took part in the period," which additionally needs `participations.view`. |
| `music.view` | Opens `/dashboards/music`, read-only. Nothing on this panel is ever withheld. |
| `promotions.view` | Opens `/dashboards/promotions`, read-only; every card except the entry side (Participations, Distinct listeners taking part, Why entries were refused, Busiest promotions, Monthly participations), which additionally needs `participations.view`. |
| `participations.view` | Fills in the one figure `members.view` alone cannot on Audience, and the whole entry side of Promotions. Held alone (without the panel's own domain permission), it unlocks nothing — the panel itself still refuses. |
| `reports.consolidated` | **Live the day this block deploys (§0, §3).** Needed in **every** Station named for a consolidated call to succeed — held in only some of them, the call is refused with 42501, never silently narrowed to the Stations it is held in. |

---

## 8. Refusals you may meet

| Message | Cause |
|---|---|
| The consolidated toggle never appears, even though two Stations are reachable | `reports.consolidated` holds in fewer than two of the Stations you reach with the panel's own domain permission — a courtesy the screen offers, not the boundary. |
| *"You do not have permission to see this dashboard in every station selected."* | A consolidated call (or a hand-typed `?companyId=` URL naming more than one Station) reached the database, and `reports.consolidated` does not hold in every Station named — the toggle's own absence did not stop the URL from being tried by hand, and the database refused it anyway (D3). |
| *"That period is not valid."* | A `22023` reached the screen — almost always an empty Station list, since `parsePeriod` already refuses an unknown preset or an impossible/reversed custom range in the browser before a request is sent. |
| A card shows an em dash and names a permission (e.g. "Needs `participations.view`.") | This is the success case for a caller who genuinely lacks that permission (D13) — not a fault. The figure was omitted, never computed as a zero. |
| The page redirects away, or never loads | The panel's own domain permission (`members.view` / `music.view` / `promotions.view`) is missing for every Station you can reach — check the role assigned there, not the account overall. |
| "No Station you can reach matches "..."." | A Station-search term matched nothing — not the same as holding the permission nowhere (the message above); clear the search to see the dashboard again. |
| A generic "could not load" sentence, with no specific reason named | An unexpected fault, not a refusal — worth reporting rather than retrying blindly. |
| Any screen fails with "function does not exist" / `PGRST202` | The deploy-order trap in §0 — check §2 before assuming a code defect. |

---

## 9. What is not here yet

- **Excel, CSV or PDF export.** Block 8b's, whole.
- **Asynchronous generation, or `saved_reports`.** Block 8b's.
- **Scheduled or emailed reports.** Block 8b's.
- **Any way to reach a fourth, custom-defined dashboard.** These three are
  the ones the master spec names; nothing here is a report builder.
