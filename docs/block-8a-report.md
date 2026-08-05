# Block 8a — Three Dashboards, One Period, and the Timezone That Makes Them True — Verification Report

**Date:** 2026-08-05
**Branch:** `block-8a` (cut from `main` at `42a3515` — merge of PR #26,
`block-templates`)
**Spec:** `docs/superpowers/specs/2026-08-05-block-8a-dashboards-design.md`
**Plan:** `docs/superpowers/plans/2026-08-05-block-8a-dashboards.md`
**Migrations:** `0115`–`0120`
**Commits:** `c66bb25..a6a2dc2` (24 commits, Tasks 1–9; this report and the
runbook are Task 10, committed separately), then `3193a17..eb4cb01` — the
whole-branch review's fix wave, §10 below

> **§10 supersedes §1 and parts of §8.** The gate numbers at the top of this
> document are the ones Task 10 measured; the ones this branch now stands on
> are in **§10.2**, re-run after the fix wave. Several items §8 lists as
> deferred minors are closed there.

Sixteen blocks had written data into this system and nothing read it back as
a number. This block gives three screens that do: **Audience**, **Music**
and **Promotions**, each over one Station or a consolidated set, each sliced
by a period computed in the Station's own timezone rather than the server's.
Three `SECURITY INVOKER` aggregate functions (D4) so RLS keeps applying
inside them; one new permission, `reports.consolidated`, for the one thing a
domain permission does not already buy — summing more than one Station into
a screen; a `withheld`, never-zeroed contract (D13) for the one figure that
crosses a permission line a panel's own gate does not cover.

---

## 1. Gates

Every gate below was re-run for this report, in the order the brief
specifies, on this machine, with real output quoted rather than summarised
from an earlier task.

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean — `✔ No ESLint warnings or errors` |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | clean, no output |
| Unit (Vitest) | `npm test` | **769 passed (769)**, 54 files — see §1.1, this did not start clean |
| DB reset | `npm run db:reset` | clean — applies through `0120_promotions_dashboard.sql` |
| pgTAP | `npm run db:test` | **`Files=22, Tests=1242`, `Result: PASS`** — `20_dashboards.test.sql` (66 assertions) `ok` |
| Isolation | `npm run test:isolation` | **24 files, 261 tests, all passed** — "24 of them required by name and each above its own case floor... nothing skipped" |
| Build | `npm run build` | clean — see §1.2 for the route table |
| E2E | `npm run test:e2e` | **not green at default parallelism; 34/34 serially** — see §1.3 |

### 1.1 Unit — a pre-existing gap this gate caught, fixed before reporting green

The first `npm test` run of this session reported **766 passed, 3 failed**,
all three inside `tests/unit/station-switch.test.ts`:

```
✗ src/app/(app)/dashboards/audience/page.tsx builds the switcher link through stationSwitchHref
✗ src/app/(app)/dashboards/music/page.tsx builds the switcher link through stationSwitchHref
✗ src/app/(app)/dashboards/promotions/page.tsx builds the switcher link through stationSwitchHref
```

`station-switch.test.ts` is a structural guard, written in Block 7a, that
scans every `page.tsx` for the Station-switcher pattern
(`viewable.map((company)`) and asserts each one spells its link through
`stationSwitchHref` — the one shared helper, because "eight screens... five
of them ended up spelling it wrong" the first time this codebase built a
switcher by hand in five places. Task 9 of this block built exactly the
ninth, tenth and eleventh such screens, and correctly did **not** use
`stationSwitchHref` — it cannot: that helper's own query type
(`{ companyId: string; station?: string }`) has no room for a period
(`preset`/`from`/`to`), so `period.ts`'s own `withStationSearch` was built
instead, carrying the identical Station-search protection through
`periodHref`'s query. This was a documented, deliberate choice (Task 9's own
report, "A deviation... and why"). What nobody ran afterward was `npm test`
— Task 9's own Verification section lists only lint, typecheck and build —
so the guard's failure on the three new screens was never seen until this
gate.

**Fixed by widening the guard, not by weakening it:** the per-screen
assertion now accepts either `stationSwitchHref(` or `withStationSearch(` as
evidence the screen carries the Station search correctly, with a comment
explaining why the three dashboard screens legitimately use the second one.
The other eight screens still require `stationSwitchHref(` specifically —
none of them import `withStationSearch` at all, so the guard is not
weaker for them. `npx vitest run tests/unit/station-switch.test.ts` after the
fix: **35/35 passed**. Full `npm test` after the fix: **769/769, 54 files**.
This is recorded as a Task 10 finding, not a Task 9 defect requiring a fix
round there — the code Task 9 shipped was correct throughout; only the test
that should have said so was stale.

### 1.2 Build — the route table

```
├ ƒ /dashboards/audience                   679 B         226 kB
├ ƒ /dashboards/music                      679 B         226 kB
├ ƒ /dashboards/promotions               10.3 kB         236 kB
+ First Load JS shared by all             102 kB
```

Task 8's own report measured the shared bundle at **103 kB with Recharts
installed but imported by nothing**; this report's own build (Recharts now
imported by all three pages, via the four chart components) measures the
shared bundle at **102 kB** — unchanged within rounding noise, confirming
Recharts' cost is per-route, not global. The three routes carry
**226–236 kB First Load JS**, matching Task 9's own numbers exactly, four
tasks and one clean rebuild later.

### 1.3 E2E — reported truthfully, not as green

`npm run test:e2e` (default parallelism, 16 workers on this machine) does
not exit 0. Before taking the measurement below, an unrelated environmental
issue was found and cleared: a `next dev` process was already listening on
port 3000 from an earlier session, started without
`WHATSAPP_APP_SECRET`/`WORKER_TICK_SECRET` — Playwright's
`reuseExistingServer` (local-only) silently reused it instead of starting
its own with `WHATSAPP_TEST_ENV`, and the three `whatsapp-boundary.spec.ts`
cases failed with `503` ("not configured") as a result, while all four new
dashboard tests passed. That process was killed and the measurement below is
a clean second run, contention included:

```
18 failed
2 did not run
14 passed (47.6s)
```

Two of the eighteen are this block's own new tests (`dashboards.spec.ts`'s
round trip and its withheld-figure case); the other sixteen are the exact
shape every earlier block's report records for this machine — `deadline`,
`delivery-flow`, `draw-flow`, `filtered-draw`, `inventory-flow`,
`invitation-flow`, `members-flow`, `music-catalogue`, `music-requests`,
`participations-flow` (×1 of its 6), `promotion-prizes`, `promotions-flow`
(×1 of its 3), `provisioning-flow`, `record-dialog`, `roles-flow`,
`templates`. Every one of the eighteen fails at the identical first step: a
freshly created platform admin's `Sign in` click times out waiting for
`/app` and lands on `/login` instead — sign-in contention under this
machine's parallelism, not a functional defect in anything this block or any
earlier one built. `whatsapp-boundary.spec.ts`'s three cases, which do not
sign in at all, passed in this run.

Run serially, fresh for this report:

```
Running 34 tests using 1 worker
...
34 passed (3.7m)
```

**34/34, including all four of `dashboards.spec.ts`'s own cases** (6.7s,
2.9s, 4.2s, 10.7s). This is the form this report's conclusions rest on, the
same conclusion every prior block's report has drawn on this machine:
`npm run test:e2e` as literally specified does not exit 0 here;
`npx playwright test --workers=1` does, completely, both numbers recorded
above rather than assumed.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0115_reports_consolidated_permission.sql` | the one new permission, `reports.consolidated` — company-scoped, live the day it lands (D3) |
| `0116_dashboard_indexes.sql` | three indexes the aggregates were measured to be missing: `member_links_company_linked_idx`, `participations_company_period_idx`, `winners_company_created_idx` |
| `0117_resolve_dashboard_period.sql` | `resolve_dashboard_period` — the one place both windows (D5/D6) are computed, per Station, from the Station's own clock |
| `0118_audience_dashboard.sql` | `get_audience_dashboard` |
| `0119_music_dashboard.sql` | `get_music_dashboard` |
| `0120_promotions_dashboard.sql` | `get_promotions_dashboard` |

Confirmed live for this report (`docker exec` into the local Postgres
container):

```sql
select code, module, label, scope from public.permissions where module = 'reports' order by display_order;
```

returns exactly one row — `reports.consolidated | reports | See a
consolidated dashboard | company` — and:

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('resolve_dashboard_period','get_audience_dashboard','get_music_dashboard','get_promotions_dashboard')
 order by p.proname;
```

returns all four, each `security_definer = f` (INVOKER, D4) and
`authenticated_can_execute = t`.

TypeScript: `src/schemas/dashboards.ts` (Zod, the payload contract of spec
§4); `src/services/dashboards.ts` (`server-only`, the three RPC callers and
`mapDashboardError`); `src/app/(app)/dashboards/period.ts` (`parsePeriod`,
`periodHref`, `withStationSearch`); `src/app/(app)/dashboards/period-control.tsx`,
`consolidated-toggle.tsx`, `dashboard-cards.tsx`, `errors.ts`; the three page
files under `audience/`, `music/`, `promotions/`; four chart components under
`src/components/charts/` (`monthly-bars.tsx`, `breakdown-bars.tsx`,
`top-list.tsx`, `split-donut.tsx`) plus `chart-colors.ts`; `src/lib/auth/shell.ts`
and `src/components/layout/app-shell.tsx` (the Dashboards nav section,
`ICONS.chart`). Tests: `supabase/tests/20_dashboards.test.sql` (66
assertions), `tests/isolation/dashboards.test.ts` (6 cases), a family of unit
tests (`dashboards-period.test.ts` and others named in Tasks 6–9's own
reports), and this task's own `tests/e2e/dashboards.spec.ts` (4 journeys).
`database.types.ts` regenerated at Task 6, carrying the three new RPC
signatures Task 7 consumes.

---

## 3. Decisions found while writing the plan or during implementation, not during brainstorming

Two of the spec's thirteen decisions were not present when the design was
first discussed — both surfaced only once someone had to make the SQL
actually agree with itself, and both are recorded in the spec document
itself as findings rather than upfront choices:

- **D12b — every Audience figure counts the same population.** Found while
  implementing Task 3: `listeners` excluded deleted and anonymised members,
  but `took_part` (reading `participations` directly) and `barred` (reading
  `member_blocks` directly) did not, because neither joined `members`. Both
  readings are individually defensible — an erased person's participation
  genuinely happened — but together they let the page print more "took part"
  than "listeners" with nothing on screen explaining why the two numbers
  count different audiences. The fix joins `members` (`deleted_at is null and
  anonymized_at is null`) into every figure on the panel; the accepted cost,
  named in the migration's own comment, is that activity by a since-erased
  listener is undercounted — the smaller of two errors next to a page that
  contradicts itself in public.
- **D13 — withheld, never zeroed.** The rule itself (a figure gated by a
  permission other than its panel's own must be omitted and named, never
  rendered as zero) is stated in the spec from the start, but its FIRST
  implementation in Task 5 got the mechanics wrong: a caller lacking
  `participations.view` had the `took_part`/`participations` figures
  **emptied** (a genuine `0`) rather than **omitted from `cards` and named in
  `withheld`** — indistinguishable, at the payload level, from a Station that
  genuinely had zero participants. Caught pre-review and fixed before Task 5
  closed; Task 6's isolation suite (cases 4–5) and Task 9's own grep audit
  (`grep -rn '?? 0\|=== 0 ?\|toFixed' "src/app/(app)/dashboards"` — one hit,
  the sentence *forbidding* it in `dashboard-cards.tsx`'s own comment) both
  confirm no `?? 0` reaches a card path anywhere in the shipped code.

Both are the exact class of finding the spec's own D12b/D13 headers describe
themselves as: a decision this project's history says is where defects hide,
caught by writing the thing rather than by discussing it.

---

## 4. Three defects the plan itself shipped, and the implementers stopped on rather than working around

None of these reached `main`. Each is a mistake in the plan's own first
draft — a comparison window, a set of fixture identifiers, a fixture write —
caught by running what was specified and refusing to patch around it
silently.

1. **A comparison window that subtracted a day-count instead of stepping a
   calendar unit.** `resolve_dashboard_period`'s first draft computed
   `v_pfrom := (v_from - (v_to - v_from))::date` for every preset. In
   Postgres, `date - date` is an integer day count, not a date — correct only
   when two adjacent calendar units happen to share a length (true for July
   into August, false for ten of twelve month pairs and every year after a
   leap year). A 31-day May minus 31 days lands on 31 March — one day of
   March plus all of April, called "the previous month." Task 2's own
   assertion for `previous_month` (`previous_to_date = from_date`) was itself
   tautological — true by construction of `v_pto := v_from`, proving nothing
   about the window's start or length — so the misalignment shipped past its
   own test. Fixed to step back by the calendar unit itself
   (`v_from - interval '1 month'`, `'1 year'`) for every calendar preset, with
   day-count subtraction kept only for `custom`, the one case with no
   calendar unit to step by. Three new assertions (stepping forward from the
   comparison window to prove it lands exactly one calendar unit before)
   failed against the buggy version and pass against the fix — reproduced in
   `docs/superpowers/sdd/.../task-2-report.md`: "Shows the old code placed
   the comparison window one day off (June 30 instead of July 1)."
2. **Fixture UUIDs containing non-hex letters.** The plan's `d8` fixture
   tagging scheme used `m` (members), `r` (roles), `u` (users) as literal
   entity codes inside hand-written UUIDs — not valid hex. `npm run db:test`
   failed before the function under test ever ran:
   `invalid input syntax for type uuid: "00000000-0000-0000-0000-0000000d8m01"`.
   The implementer stopped and reported BLOCKED rather than picking
   replacement letters unilaterally, since the same identifiers are reused
   verbatim by two later tasks and a unilateral rename would have desynced
   three briefs. The plan was corrected to an all-numeric
   `0000d8<EE><NNNN>` scheme and the brief re-issued before work resumed.
3. **A fixture write left inside an authenticated block, which aborts the
   file rather than doing nothing.** With the UUID fix applied, the next run
   failed differently: `permission denied for table member_company_links`.
   The fixture insert ran while the pgTAP session's role was still
   `authenticated`, and `0035_rls_members.sql` revokes insert/update/delete on
   `member_company_links` (and `members`, `member_blocks`) from
   `authenticated` outright — every real write in this system goes through a
   `SECURITY DEFINER` RPC instead. pgTAP runs each file as one transaction,
   so this does not silently skip a row; it aborts everything after it in
   the file. The implementer again reported rather than patched; the
   coordinator confirmed the same latent gap in two later tasks' briefs and
   fixed it once, as a standing rule: every fixture write outside a real RPC
   call is bracketed `reset role;` (migration role, bypasses RLS) before it
   and `set local role authenticated;` plus the JWT claim after, restoring
   the session to what a real caller's would look like for the assertions
   that follow.

---

## 5. The e2e checklist — what was covered, how, and what could not be proven

`tests/e2e/dashboards.spec.ts` adds four journeys. Every listener, role,
invitation, prize, promotion and participation used as fixture data is
created directly through the same RPCs `tests/isolation/harness.ts` calls
(`create_member`, `create_role`, `create_invitation` + `accept_invitation`,
`assign_company_role`, `create_prize`, `record_stock_entry`,
`create_promotion`, `link_prize_to_promotion`, `record_participation`),
signed in as the owner, who bypasses `has_permission` for their own
Organization (0024) — the same shortcut every other e2e spec in this
codebase already takes for setup that is not the feature under test. The
five Playwright sessions are spent entirely on what only a rendered screen
can prove.

| Checklist item | Covered by | Notes |
|---|---|---|
| The withheld-vs-present branch | Test 2 | A delegate holding `members.view` but not `participations.view`, at a Station with a real listener AND a real recorded participation. `dashboard-card-listeners` reads `1` (real); `dashboard-card-took_part`'s value paragraph reads exactly `—`, and `participations.view` is visible in the same tile; `dashboard-card-barred` reads a genuine `0` with no permission text anywhere in it — the contrast that proves "no data" and "not permitted" render differently in both directions. |
| The no-match-search branch vs. the `redirect('/app')` branch | Test 3 | The same page, two distinct delegates: one with `members.view` at a real Station gets the "No Station you can reach matches…" card for a nonsense search term (and recovers via "Clear the Station search"); the other, holding `music.view` nowhere near `members.view`, is redirected to `/app` on the bare URL with no search term at all. |
| The mixed-timezone note firing and not firing | Test 4 | Two real Stations, `America/Sao_Paulo` and `America/New_York`. `mixed-timezone-note` is absent on the single-Station view, appears the instant "All stations" is chosen, and disappears again on "This station." |
| The consolidated toggle: visible only when eligible; a hand-crafted URL beyond the grant | Test 4 | One delegate holds `reports.consolidated` in both Stations — the toggle renders and both directions work. A second delegate holds it in only one of the same two Stations — the toggle is entirely absent (though both Station pills still render, since `members.view` holds in both) — and a hand-crafted `?companyId=A&companyId=B` URL, bypassing the toggle, reaches the RPC and is refused with the exact sentence `describeDashboardError` gives an `UnauthorizedError`, with `dashboard-cards` absent — never data, never zeros. |
| `period-control.tsx`'s custom-range inputs re-syncing across a sibling control's navigation | Test 4 | See below — covered with a stated limit. |

**What the custom-range case proves, and what it cannot.**
`resolve_dashboard_period`'s `custom` branch takes `p_from`/`p_to` verbatim,
for any Station or any consolidated set (§0117 read closely: `v_from :=
p_from; v_to := p_to`, unconditionally) — only the comparison window is
derived from them, never the chosen window itself. That means switching
Station or toggling consolidated while custom is active can never make the
payload's own `period.from`/`period.to` differ from what was already on
screen: this file cannot construct a case where a sibling control's
navigation hands the resync effect a genuinely different value to pick up,
because 0117 never produces one under these two navigations. What Test 4
does prove, deterministically: an operator's typed custom range (`2020-01-01`
to `2020-02-01`) survives, unchanged, a Station-pill click and a
consolidated-toggle click — the "Custom range" pill stays `aria-current`,
and both date inputs still read the operator's own values, not a blank pair,
not a silent reversion to the default preset. That is the concrete
regression `period-control.tsx`'s own header comment names
(`station-switch.ts`'s history, and `members-filters.tsx`'s
near-identical resync) — a control that drops the current selection on a
sibling navigation. It is not a proof that the `useEffect` fires on a
changed value, because under 0117's own semantics for `custom`, nothing
reachable through these two controls ever changes that value. This is
stated plainly rather than asserted past: no test in this file claims to
have exercised a case it did not.

Nothing in the brief's checklist was left uncovered or built weaker than
claimed. The five items above are each reachable and each distinguished from
its neighbour by a real assertion, not merely present in source.

---

## 6. What Block 8b inherits

Per spec §8, verbatim: **the three aggregate functions, the period contract
of D5/D6, and the permission rule of D2/D3.** A report is the same query
with a file at the end; 8b should call `get_audience_dashboard`,
`get_music_dashboard` and `get_promotions_dashboard` (or the same SQL
`resolve_dashboard_period` shape) rather than write a fourth way to count the
same rows. Not in 8a, and deliberately: Excel/CSV/PDF export, asynchronous
generation, `saved_reports`, scheduled or emailed reports.

**The trap 8b and every future deploy inherit, and `docs/block-8a-runbook.md`
opens with it, because Block 7a paid for it once already:**
`has_permission`'s first line requires the permission code to exist in
`public.permissions`. `reports.consolidated` ships in `0115`; a frontend
reaching production ahead of `supabase db push` will offer the consolidated
control and fail every call behind it with `PGRST202`/"function does not
exist" or a permission-denied shape that names nothing about a deploy order.

**Also inherited, stated exactly as D3's own header states it:**
`reports.consolidated` is **live the day it ships** — unlike `music.request`
in 7a, which shipped assignable at zero capability and acquired a real one a
block later, any role holding this code the moment `0115`–`0120` land reads
the whole group's numbers in one screen. Auditing who holds it is a
before-deploy question, not an after one.

---

## 7. Files changed (this task)

- `M:\CRM - LISTENER\tests\e2e\dashboards.spec.ts` (new — 4 journeys)
- `M:\CRM - LISTENER\tests\unit\station-switch.test.ts` (modified — widened
  the per-screen guard to accept `withStationSearch(` alongside
  `stationSwitchHref(`; see §1.1)
- `M:\CRM - LISTENER\docs\block-8a-report.md` (new — this file)
- `M:\CRM - LISTENER\docs\block-8a-runbook.md` (new)

---

## 8. Deferred minors, collected from the execution ledger

None blocking, none load-bearing; carried here from `progress.md` for the
owner's final triage rather than repeated at length.

- Task 2: the null/empty-timezone guard in `0117` is unexercised by any
  assertion.
- Task 3: assertion 27 checks only that discovery buckets sum to the total
  (a mislabelled bucket would pass); withheld-case assertions do not confirm
  `listeners`/`new_listeners` stay present for that same caller; Diana/Elisa
  fixture links use `now()` for `linked_at` unlike every other fixture row's
  literal timestamp.
- Task 4: `cards.new_songs` has no assertion anywhere; `0119`'s header
  comment misdescribes `0118`'s `blocks_by_kind` as reading "a pre-filtered
  slice" — it doesn't; no assertion for an empty-catalogue Station or a
  zero-request window (safe by inspection).
- Task 5: stale assertion-number comments at two lines, shifted +2 by a
  fix round.
- Task 6: `dashboards.test.ts` case 4 grants a permission
  (`promotions.view`) the function under test never checks, with a comment
  that misdescribes case 5; cases 2, 3 and 5 rest on structural argument
  rather than mutation evidence.
- Task 7: no unit test exercises `src/schemas/dashboards.ts` directly (only
  `parsePeriod` is tested) — flagged in `progress.md` as the schema-level gap
  D13 could most silently break; `describeDashboardError`'s `22023` sentence
  is fixed text rather than forwarding `cause.message`.
- Task 8: chart heights are hardcoded (`h-72`/`h-80`) rather than props;
  figure/aria-label naming could be hardened for older assistive tech.
- Task 9: the sidebar shows two "Audience" entries in different sections
  (Dashboards > Audience, a real link; Audience > Members/Participations, a
  section heading) — functional, flagged as a naming question for the owner,
  not fixed here; a redundant `||` in the switcher-visibility gate;
  three ~250-line page files duplicate the banner/switcher/timezone-note
  block near-verbatim across `audience/`, `music/`, `promotions/`.
- Task 10 (this one): `Date.now()` gives millisecond-resolution stamps, the
  same pre-existing pattern every other e2e spec in this codebase already
  shares, not introduced here. The five test identities in
  `dashboards.spec.ts` are created via direct RPC calls rather than the
  browser's own `/invite/<token>` acceptance form — deliberate, and covered
  at least once elsewhere in this suite (`members-flow.spec.ts`,
  `inventory-flow.spec.ts`, `roles-flow.spec.ts`), so this file does not
  re-prove that form works, only that the three dashboard screens render
  correctly for an identity that came through it.

---

## 9. Not done

**The PR is not open.** The owner decides when it opens, per house
convention carried from every earlier block.

**Nothing beyond this plan's own scope was started.** Excel/CSV/PDF export,
asynchronous generation, `saved_reports`, scheduled or emailed reports all
remain Block 8b's, per §6 above.

---

## 10. The whole-branch review, and the fix wave that answered it

All ten tasks were reviewed together against the branch diff once they were
merged. **No Critical finding.** Nine Important, several Minor, and two
questions the owner ruled on directly. One dispatch fixed the list; the full
account, including the `EXPLAIN` plans and the two findings argued down, is in
`.superpowers/sdd/2026-08-05-block-8a-dashboards/fix-wave-report.md`.

Commits: `3193a17` (SQL), `085aa53` (one performance defect the measurement
turned up), `9adef9e` (screens), `9927ca8` (tests), `eb4cb01` (e2e).

### 10.1 What the review found, and what changed

**The two owner decisions.**

- **Presets across timezones.** D5 was amended before the wave (`d8869d0`) and
  the arithmetic kept: each Station measures its own month, because a Station
  is not well measured by a calendar it does not live in. What was wrong was
  the **reporting** — all three pages printed, unconditionally, *"The period's
  dates are the same for all of them"*, which is true of a custom range and
  false of a preset resolved at two distant clocks. The payload's `stations`
  entries now carry each Station's own `from`/`to`, and one shared component
  fires on the real condition: different windows → say so and name which
  Station measured which; same window, different zones → the original
  sentence, kept verbatim; neither → nothing.
- **Nav labels.** The three Dashboards items are now "Audience overview",
  "Music overview", "Promotions overview". Every one of the bare words was
  already a **section** heading further down the same sidebar — the rule
  `shell.ts` records for Inventory > Stock, violated three times at once.

**The nine Important.**

1. **`blocks_by_kind` dropped an enum value with zero rows.** A plain
   `group by kind`, so a period in which nobody was suspended drew a one-bar
   chart and a reader could not tell "nobody was suspended" from "this chart
   does not cover suspensions" — the exact failure `0119`'s header argues
   against at length, in the one breakdown of five not written to avoid it.
   Now `unnest(enum_range(…)) LEFT JOIN`, like its four siblings.
2. **Charts printed raw enum codes** beside a bucket labelled "Not stated" —
   one axis, two vocabularies, and the mixed one is the tell. Fixed
   client-side through the four label Records this codebase already has, which
   is what the payload's `key`/`label` split was for. No fifth vocabulary.
3. **`parsePeriod` accepted `from === to`,** which `0117` refuses, so picking
   one date in both inputs replaced the page with an error. Two comments
   asserted this could not happen; both were false for that input and both now
   say so.
4. **The custom range's `To` bound was exclusive and nothing said so.** An
   operator asking for August lost the 31st from every figure, silently. The
   input now means the last day INCLUDED and converts once at its own edge;
   the URL and the RPC keep the half-open bound. The round trip is pinned by
   unit tests and by the e2e.
5. **Only `barred` disclosed that it counts distinct members.** `listeners`,
   `new_listeners` and `took_part` do too, so none is the sum of its parts in
   a consolidated view. All four now carry the caveat when consolidated.
6. **Three source CTEs read all of history.** Each is multiply-referenced, so
   Postgres materialises it and pushes no date predicate down. Bounded, as
   semantic no-ops. **Measured, not argued:** with eight Stations and 400,000
   participations the promotions aggregate went 98.4 ms → 60.1 ms, its
   materialised CTE 50,000 → 15,705 rows, its temp I/O 794 → 250 blocks. Two
   things the measurement settled against the review's own phrasing:
   `participations_company_period_idx` is used on its **first column only**
   even after the rewrite (the date arrives from a lateral function scan the
   planner will not push into an index), and
   **`member_links_company_linked_idx` is never chosen at all** — Postgres
   prefers `0031`'s single-column `(company_id)` index in every plan,
   including an isolated read against a literal date. Whether to drop it is
   the owner's call, made from that evidence.
7. **"All stations (N)" could be fewer than all stations** — the count came
   from two lists both capped at fifty and both narrowed by the active search,
   and the caveat rendered only for the cap. The label now reads from the real
   relationship and the caveat fires for a search too.
8. **Eight payload keys had no assertion anywhere.** All eight now do. The two
   that mattered: `monthly` — the block's only timezone-sensitive arithmetic
   after the period resolver, written out three times and never once run
   against data — is pinned by the same 23:30-local row that pins
   `new_listeners`, landing in August at Sao Paulo and September at UTC; and
   `live_now`, the aggregate's only consumer of `promotion_is_live`, is pinned
   by three purpose-built promotions defined relative to `now()` so exactly one
   is live on any day, for ever.
9. **`src/schemas/dashboards.ts` had no test** — the only layer of the D13
   chain without one, and the one that decides what "omitted" means to
   TypeScript. Seven cases now cover it, which needed the three `cards`
   objects to become `.strict()`; the deploy-order cost of that is stated in
   the schema's own header.

**The nine Minor,** all done: the `group by` that made `' Instagram '` a second
bucket printed `Instagram`; `0119`'s false claim about `0118`; one
`jsonb_strip_nulls` shape across all three payloads, with `stations` coalesced;
a header line on the archived-promotion join (see below); D11's third instant
on both sides; the withheld path no longer scanning a table whose answer it
throws away; `0117` declaring `security invoker`; and `barred` no longer
counting a dated block that expired on its own — `is_member_blocked` has always
derived in force from `ends_at` too, and `0032` is explicit that a dated
suspension ends because the date passed. Spec §3.1 was amended to match.

The stale assertion-number comments were fixed by **removing the numbers**:
they had gone stale twice already, this wave inserts 21 assertions above them,
and an ordinal in a comment is a fact nothing keeps true.

### 10.2 Gates, re-run after the wave

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | **783 passed (783)**, 55 files (was 769/54) |
| `npm run db:reset && npm run db:test` | **`Files=22, Tests=1263`, `Result: PASS`** — `20_dashboards.test.sql` 87 assertions (was 66) |
| `npm run test:isolation` | **24 files, 261 tests, all passed** — on the third attempt; runs 1 and 2 hit the `Worker exited unexpectedly` flake the verifier's own header documents at two runs in five, and both were refused as incomplete rather than counted |
| `npm run build` | clean; route table byte-for-byte unchanged at 226/226/236 kB |
| `npm run test:e2e` | **not green at default parallelism**, as before: `19 failed / 2 did not run / 13 passed`, and `20 failed / 2 did not run / 12 passed` on a second run. The same shape §1.3 records — every failure is the sign-in step timing out under contention |
| `npx playwright test --workers=1` | **34 passed (3.8m)** — 34/34 |

Two e2e notes worth keeping. The wave's own e2e change was **caused by** a fix:
`dashboards.spec.ts` asserted the old exclusive `To` semantics and rightly
failed once the input became inclusive. And a serial run began failing
`roles-flow.spec.ts` at `/invite/<token>?error=failed`, on a spec nothing here
touches — `acceptInvitation`'s IP-keyed rate limiter, exhausted by repeated
full runs from one machine, the "invitation limiter that pretends to be a
regression" already on record from Block 3b. **Run `npm run db:reset` before a
serial e2e run you intend to trust.**

### 10.3 Two findings not implemented, and one the review did not find

- **Bounding `0119`'s `song` CTE by `created_at` would be a wrong number, not a
  slower one.** `request` joins that CTE to reach each song's nationality and
  vocal, and `record_music_request` takes an operator-supplied `requested_at`
  (`0107:139-142`), so a request inside the window can legitimately belong to a
  song catalogued after it closed. The bound would silently drop it from every
  music figure. The catalogue cards' own filters are the right place, and are
  already there; the reasoning is now in `0119`'s own comment so the obvious
  bound is not re-applied.
- **The archived-promotion discrepancy does not exist.**
  `participations_select_participations_view` (`0053:25-30`) already carries
  `promotion_id in (select id from public.promotions)`, and that subquery is
  itself filtered by `0044`'s policy — so a caller who cannot see an archived
  promotion cannot see its participations either, and `cards.participations`
  and `top.promotions` move together for every caller. A header line was still
  added, because a reader *should* stop at that join; it now records what they
  will find.
- **One defect the review did not name, found by the measurement it asked
  for.** `0118`'s `discovery` and `first_contact` re-joined `members` a second
  time — against a materialised CTE, which carries no index. One measured plan
  chose a nested loop: **3,998,000 rows removed by join filter for 2,000
  listeners**, quadratic in the Station's own audience. The two columns are now
  carried on the `link` CTE that already joins `members`, and the second join
  is gone (`085aa53`).

### 10.4 Still open, for the owner

- **Dropping `member_links_company_linked_idx`** (`0116`). The evidence says it
  buys nothing; no migration was written either way.
- **The three dashboard pages still duplicate their banner, switcher and
  Station-search block near-verbatim.** This wave moved the period note out of
  all three into one component and left the rest, since §8 lists the
  duplication as a Task 9 deferred minor rather than a review finding.

### 10.5 Owner decision, 2026-08-05: `.strict()` stays, and it opens a second deploy-order trap

Item 9 above records that the three `cards` schemas became `.strict()` to make
`src/schemas/dashboards.ts` testable at all — a payload with an unrecognised
key must fail loudly, or nothing distinguishes a real omission (D13) from a
typo. The re-review flagged this as a production behaviour change introduced
to satisfy a test, not a design decision anyone had actually taken, and asked
the owner to rule on it rather than let it stand by default.

**Ratified as a decision, not an accident.** `.strict()` is what spec §7
already promised — "the Zod payload schemas reject a malformed `jsonb`" — and
it is the only layer where the D13 contract (a withheld figure is omitted,
never zeroed) is proven at the boundary where a caller's code actually reads
it, rather than only in the SQL that produces it.

**The cost is a second deploy-order trap, the mirror of the one this
document's own runbook opens with.** That trap is frontend-ahead-of-database:
`reports.consolidated` missing from `public.permissions` fails every
consolidated call with a permission error that names no migration. This one is
database-ahead-of-frontend: a migration that adds a `cards` key one of the
three functions did not used to send, shipped ahead of the matching line in
`src/schemas/dashboards.ts`, makes `schema.parse` throw on the **whole page**,
not one figure — `.strict()` refuses the unknown key instead of silently
dropping it. The two failures look nothing alike, which is the point: a
permission error per action versus a parse error taking down the entire
dashboard is what tells whoever is on call which direction was missed. Both
halves are now stated together in `docs/block-8a-runbook.md` §0, and the
schema file's own header already carried this cost before the re-review
raised it, so no change was needed there.
