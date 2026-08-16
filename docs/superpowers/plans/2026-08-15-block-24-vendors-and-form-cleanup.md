# Block 24 — Vendors and form cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's list of 2026-08-15, eight items — a title filter on the
Deezer search, four dead fields off the promotion screens, moderation guidelines
on a Poll question, a View window and a promotion thumbnail on Participations, a
Vendors screen under Inventory, and a Vendor on each stock entry.

**Architecture:** Three unrelated jobs in one block. The removals take fields off
screens and out of schemas and leave every column in place; where the database
still requires a value (`promotion_questions_list_fields`), the save action
supplies a default constant instead. The additions follow shapes this repository
already has: `/shows` for the new screen, `AttendDialog` for the new window,
`RequestsGrid`'s `covers` map for the new thumbnail, and `0193`'s
`reserved_for_show_id` for the new movement column.

**Tech Stack:** Next.js 15 (App Router, Server Components, Server Actions),
React 19, TypeScript, Supabase (Postgres + PostgREST + RLS), next-intl, Zod 3,
Vitest, Playwright, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-15-block-24-vendors-and-form-cleanup-design.md` —
read it before Task 1. Decisions are referenced below as D1…D10.

## Global Constraints

- **Migrations are append-only and numbered.** The next free numbers are `0197`
  through `0200`. Never edit a migration that has shipped.
- **RECREATE A FUNCTION FROM ITS LIVE DEFINITION, NEVER FROM THE MIGRATION THAT
  FIRST CREATED IT.** This repository has shipped that defect three times. Before
  writing `0199`, run `pg_get_functiondef` against a freshly reset local database
  for `record_stock_entry` and `list_movements` and copy those bodies forward.
  `record_stock_entry` lives in `0194`, not `0027`; `list_movements` lives in
  `0196`, not `0096`.
- **A migration must reach the hosted database with the deploy.** Three blocks
  (13a, 17b, 17c) shipped code whose migrations stayed behind. The push happens
  before the deploy is requested.
- **Permission before existence**, `22023` for a business refusal, `42501` for a
  missing permission, `security definer` + `set search_path = pg_catalog,
  public`, `revoke … from public` then `grant … to authenticated` — the house
  rules every migration in this repository follows.
- **No permission is created.** D6. Vendors use `inventory.view` and
  `inventory.catalogue`.
- **Nothing is dropped from `promotions` or `promotion_questions`.** D2.
- **Code, comments, commit messages and documentation in English.** UI copy goes
  through `next-intl`; every key exists in `messages/en.json`, `pt.json` and
  `es.json` or `tests/unit/i18n/catalogue.test.ts` fails.
- **Gate order:** `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run db:reset`, `npm run db:test`, `npm run seed:branding`,
  `npm run test:e2e`, `npm run test:isolation`. `db:test` after the reset and
  never after an e2e run — a dirty local database gives two false reds.
- **Run every suite in the foreground** with an explicit long timeout. Never run
  two things against the database at once.
- **Branch:** `block-24-vendors-and-form-cleanup`, already created off `main`.
- **Commit after every task.**

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0197_vendors.sql` | The table, its indexes, RLS and the select policy |
| `supabase/migrations/0198_vendor_doors.sql` | `save_vendor`, `archive_vendor`, the widened permission description |
| `supabase/migrations/0199_movement_vendor.sql` | `vendor_id` + constraints; `record_stock_entry` and `list_movements` recreated |
| `supabase/migrations/0200_question_moderation_guidelines.sql` | The column, its shape check, and `set_question_moderation_guidelines` |
| `src/services/vendors.ts` | Read one page, read the reference list, save, archive |
| `src/app/(app)/inventory/vendors/page.tsx` | The screen |
| `src/app/(app)/inventory/vendors/list-params.ts` | URL state, cursor, hrefs |
| `src/app/(app)/inventory/vendors/vendors-filters.tsx` | The filter bar |
| `src/app/(app)/inventory/vendors/vendors-grid.tsx` | The grid, the record modal host, the archive confirmation |
| `src/app/(app)/inventory/vendors/vendor-form.tsx` | The record form |
| `src/app/(app)/inventory/vendors/actions.ts` | `saveVendorAction`, `archiveVendorAction` |
| `src/app/(app)/inventory/vendors/errors.ts` | SQLSTATE → sentence |
| `src/schemas/vendors.ts` | `vendorFormSchema` |
| `src/app/(app)/participations/participation-dialog.tsx` | The View window |
| `supabase/tests/43_vendors.test.sql` | pgTAP for the table, both doors and the movement column |
| `supabase/tests/44_moderation_guidelines.test.sql` | pgTAP for the column and its door |
| `tests/isolation/vendors.test.ts` | Cross-Station isolation |
| `tests/unit/deezer-title-filter.test.ts` | The predicate |
| `tests/unit/vendors-schema.test.ts` | `vendorFormSchema` |
| `tests/e2e/vendors.spec.ts` | Register, edit, filter, archive; a vendor on an entry |
| `tests/e2e/participation-record.spec.ts` | The View window |

**Modified**

| Path | Change |
|---|---|
| `src/lib/integrations/deezer/transport.ts` | `isExcludedTitle` beside `buildSearchQuery` |
| `src/lib/integrations/deezer/client.ts` | `search` filters by it |
| `src/lib/integrations/deezer/fake.ts` | Same filter, so e2e proves the screen |
| `src/lib/conversation/engine.ts` | Two default constants |
| `src/app/(app)/promotions/whatsapp-fields.tsx` | Yes/No labels removed |
| `src/app/(app)/promotions/promotion-fields.tsx` | Call to action removed |
| `src/app/(app)/promotions/quiz-tab.tsx` | Menu title/button label removed; guidelines added |
| `src/app/(app)/promotions/actions.ts` | Stops posting four fields; sends two constants; writes guidelines |
| `src/schemas/promotions.ts` | Four fields leave two schemas |
| `src/services/promotions.ts` | Nulls for the three; `moderationGuidelines` on the question type |
| `src/app/(app)/participations/page.tsx` | Thumbnail map, permissions for the window |
| `src/app/(app)/participations/participations-grid.tsx` | Thumbnail column, View column |
| `src/app/(app)/participations/actions.ts` | `readParticipationAnswersAction` |
| `src/services/participations.ts` | `getParticipationAnswers` |
| `src/services/inventory.ts` | `vendorId` on the entry input; `vendorName` on a movement |
| `src/app/(app)/inventory/stock-entry-form.tsx` | The Vendor picker |
| `src/app/(app)/inventory/movement-history.tsx` | Vendor beside the invoice |
| `src/app/(app)/inventory/record.ts` | Active vendors travel with the record |
| `src/app/(app)/inventory/actions.ts` | `vendorId` through the entry action |
| `src/schemas/inventory.ts` | `vendorId` on the entry schema |
| `src/lib/auth/shell.ts` | The Vendors nav item |
| `src/lib/supabase/database.types.ts` | Regenerated |
| `messages/{en,pt,es}.json` | Every new key; removed keys deleted |
| `docs/PERMISSIONS.md` | `inventory.catalogue` now names vendors |

---

## Tasks

### Task 1 — The Deezer title filter (item 1, D1)

- [ ] Write `tests/unit/deezer-title-filter.test.ts` first: each of the five
      terms in lower, upper and mixed case is excluded; `Discover`,
      `Undercover`, `Recover` and `Coverage` are NOT excluded (the bare word
      `cover` is not a term — only the five bracketed/parenthesised forms and
      `karaoke`); an empty title is not excluded.
- [ ] `isExcludedTitle(title: string): boolean` in `transport.ts`, beside
      `buildSearchQuery`, with the term list as a module constant.
- [ ] `client.ts` — `search()` filters mapped tracks through it. `track()` does
      NOT (D1: a registered recording must stay resolvable by id).
- [ ] `fake.ts` — the same filter in its own `search`, so `tests/e2e/deezer.spec.ts`
      exercises the real path.
- [ ] Check `tests/unit/deezer-client.test.ts` and `tests/e2e/deezer.spec.ts`
      still pass; if a fixture title contains a term, the fixture changes, not
      the filter.
- [ ] Commit.

### Task 2 — Four fields leave the screens (items 2, 3, 4 — D2, D3)

- [ ] Two constants in `engine.ts` beside `DEFAULT_YES_BUTTON_LABEL`:
      `DEFAULT_QUESTION_MENU_TITLE` (≤ 24 chars) and
      `DEFAULT_QUESTION_BUTTON_LABEL` (≤ 20 chars), with the comment saying why
      they exist — `promotion_questions_list_fields` requires the values, the
      screen no longer collects them.
- [ ] `schemas/promotions.ts` — remove `callToAction`, `yesButtonLabel`,
      `noButtonLabel` from `promotionFormSchema` (and the two entries in the
      `!whatsappEnabled` stray check), and `menuTitle`/`buttonLabel` from
      `questionFormSchema` (and the ESSAY branch's issue about them). Update
      `tests/unit/promotions-schema.test.ts` in the same commit.
- [ ] `promotions/actions.ts` — stop reading the three promotion fields; the
      question action sends the two constants when `kind !== 'ESSAY'` and null
      when it is.
- [ ] `services/promotions.ts` — `p_call_to_action`, `p_yes_button_label`,
      `p_no_button_label` sent as null. `savePromotionQuestion`'s signature keeps
      taking the two list fields; its caller now supplies constants.
- [ ] Remove the inputs from `whatsapp-fields.tsx`, `promotion-fields.tsx` and
      `quiz-tab.tsx`. Delete now-unused imports (`Textarea` in
      `promotion-fields.tsx`) and the orphaned message keys in all three locales.
- [ ] `tests/unit/conversation-engine.test.ts` and
      `tests/unit/whatsapp-interactive.test.ts` must still pass unchanged — what
      WhatsApp sends does not change (D3).
- [ ] Verify the e2e promotion journeys do not type into the removed fields.
- [ ] Commit.

### Task 3 — `0200`: moderation guidelines (item 5, D4, D5)

- [ ] `0200_question_moderation_guidelines.sql`:
      the column, `promotion_questions_guidelines_shape` (null unless
      `kind = 'ESSAY'`), and `set_question_moderation_guidelines(uuid, text)` —
      `SECURITY DEFINER`, `promotions.edit` resolved from the question's row,
      `42501` without it, `22023` for a non-`ESSAY` question or an unknown id,
      blank stored as null, **no participation check**.
- [ ] `supabase/tests/44_moderation_guidelines.test.sql`: the gate; the
      non-`ESSAY` refusal; the shape constraint; and the case that matters —
      **a promotion with participations still accepts the guidelines** while
      `save_promotion_question`'s REPLACE branch on the same question is refused.
- [ ] `npm run db:reset` then `npm run db:test`.
- [ ] Regenerate `database.types.ts`.
- [ ] Commit.

### Task 4 — The guidelines on the quiz screen (item 5)

- [ ] `services/promotions.ts` — `moderationGuidelines` on `PromotionQuestion`,
      selected in the question read; `setQuestionModerationGuidelines`.
- [ ] `PromotionDetail` (or the record read) exposes whether the promotion is
      frozen. It already counts participations — reuse that count rather than
      adding a second question to the database.
- [ ] `promotions/actions.ts` — `saveQuestionModerationGuidelinesAction`; and
      `savePromotionQuestionAction` writes the guidelines through the narrow door
      after a successful save, using the id the RPC returns.
- [ ] `quiz-tab.tsx` — the textarea when `kind === 'ESSAY'`, labelled and hinted
      as internal-only. When the promotion is frozen, the form renders every
      other field read-only with a sentence saying why and offers only this one
      (D4). `QuizTab` takes `frozen`.
- [ ] The guidelines appear on the question card in the list, so a reader sees
      them without opening the form.
- [ ] Locale keys in all three files.
- [ ] Commit.

### Task 5 — `0197` and `0198`: the vendors table and its doors (item 7, D6, D8)

- [ ] `0197_vendors.sql` — the table per spec §4, `vendors_name_unique`,
      `vendors_id_company_unique` (non-partial, for `0199`'s foreign key),
      `vendors_company_idx`, RLS on, `select` gated on `inventory.view`, grants
      per the house rules. No insert/update/delete policy.
- [ ] `0198_vendor_doors.sql` — `save_vendor` and `archive_vendor` per spec §4,
      plus the `update public.permissions` naming vendors in
      `inventory.catalogue`'s description and label.
- [ ] `supabase/tests/43_vendors.test.sql` — the select policy; both doors'
      `42501`; the archived and blank-name `22023`s; the name uniqueness; that
      `archive_vendor` resolves `company_id` from the row.
- [ ] `npm run db:reset`, `npm run db:test`.
- [ ] Regenerate `database.types.ts`.
- [ ] Commit.

### Task 6 — The Vendors screen (item 7)

- [ ] `src/schemas/vendors.ts` — `vendorFormSchema`, mirroring the column
      lengths and the required name. `tests/unit/vendors-schema.test.ts`.
- [ ] `src/services/vendors.ts` — `listVendorsPage` (PostgREST + keyset, the
      shape `services/shows.ts` uses), `listActiveVendors` (the reference list
      Task 9 needs), `saveVendor`, `archiveVendor`.
- [ ] The screen: `page.tsx`, `list-params.ts`, `vendors-filters.tsx`,
      `vendors-grid.tsx`, `vendor-form.tsx`, `actions.ts`, `errors.ts` — `/shows`
      with different columns, per spec §5.4.
- [ ] `shell.ts` — the nav item, third under Inventory, `ICONS.building`, with a
      comment recording the non-adjacency argument.
- [ ] Locale keys in all three files.
- [ ] `tests/isolation/vendors.test.ts` — Station A's vendor is invisible and
      unwritable from Station B.
- [ ] Commit.

### Task 7 — `0199`: the vendor on a movement (item 8, D7)

- [ ] **First**, against a freshly reset local database, dump the live
      definitions:
      `select pg_get_functiondef('public.record_stock_entry(uuid,uuid,public.inventory_movement_type,integer,text,text,text,numeric,numeric)'::regprocedure);`
      and the same for `list_movements`. Write `0199` from those bodies.
- [ ] `0199_movement_vendor.sql` — the column, the composite foreign key, the
      `inventory_movements_vendor_reference` check, `record_stock_entry`
      recreated with `p_vendor_id` (refusing another Station's or an archived
      vendor with `22023`), and `list_movements` recreated with `vendor_name`
      by left join.
- [ ] Extend `43_vendors.test.sql`: `vendor_id` accepted on an entry, refused on
      an exit by the check, refused across Stations by the door; `vendor_name`
      appears in `list_movements` and an entry with no vendor still lists.
- [ ] Extend `tests/isolation/vendors.test.ts` with the cross-Station entry
      refusal.
- [ ] `npm run db:reset`, `npm run db:test`.
- [ ] Regenerate `database.types.ts`.
- [ ] Commit.

### Task 8 — The vendor on the entry form (item 8, D9)

- [ ] `schemas/inventory.ts` — optional `vendorId` on the entry schema.
- [ ] `services/inventory.ts` — `vendorId` through `recordStockEntry`;
      `vendorName` on the movement type.
- [ ] `inventory/record.ts` — the Station's active vendors travel with the prize
      record.
- [ ] `stock-entry-form.tsx` — a filter input and a `Select` beneath it, between
      the invoice number and the unit price. Optional. It must survive the Tipo
      round trip like every other field in that branch, which means lifted state,
      not an uncontrolled input.
- [ ] `movement-history.tsx` — the vendor beside the invoice number on entry
      rows.
- [ ] `inventory/actions.ts` — `vendorId` posted through.
- [ ] Locale keys in all three files.
- [ ] Commit.

### Task 9 — The participation window and the thumbnail (item 6, D10)

- [ ] `services/participations.ts` — `getParticipationAnswers(participationId)`,
      a PostgREST select over `participation_answers` embedding the question and
      the chosen option, ordered by question position, returning the prompt, the
      kind, the moderation guidelines, the chosen option's label and
      `is_correct`, and the written text.
- [ ] `participations/actions.ts` — `readParticipationAnswersAction`.
- [ ] `participation-dialog.tsx` — spec §5.3. `maskedPhone` imported from
      `music/requests/request-status.tsx`. The `useEffect` that clears the id
      when the row leaves the page is copied from `requests-grid.tsx`, not
      re-derived.
- [ ] `participations-grid.tsx` — the thumbnail first column, the View column
      sticky right, `COLUMN_COUNT` updated from 6 to 8.
- [ ] `participations/page.tsx` — the thumbnail map for the page's distinct
      promotion ids, in one query.
- [ ] Locale keys in all three files.
- [ ] `tests/e2e/participation-record.spec.ts` — open the window from the grid,
      assert the name, the four digits, the answers, the guidelines on a Poll
      question, and that it closes.
- [ ] Commit.

### Task 10 — e2e for Vendors, and the gates

- [ ] `tests/e2e/vendors.spec.ts` — register, edit, filter, archive; then record
      a stock entry naming the vendor and assert the history shows it.
- [ ] `docs/PERMISSIONS.md` — `inventory.catalogue` names vendors.
- [ ] Every gate in order, foreground, long timeout:
      `typecheck`, `lint`, `test`, `db:reset`, `db:test`, `seed:branding`,
      `test:e2e`, `test:isolation`.
- [ ] Commit, push, open the PR.

---

## Risks

- **`record_stock_entry` and `list_movements` recreated from the wrong source.**
  The single most likely way to break this block, and this repository has done it
  three times. Task 7's first step exists to prevent it.
- **The removed fields still being required somewhere.**
  `promotion_questions_list_fields` is the one that bites; `promotions_whatsapp_shape`
  is the one that does not, because it requires the labels to be *null* when
  WhatsApp is off, which is now always. Task 2's unchanged engine tests are the
  proof.
- **The participation window resurrecting itself.** `requests-grid.tsx` shipped
  that defect and fixed it with an effect; the copy must include the fix.
- **A vendor list too large for one payload** (D9). Accepted; the picker changes
  and nothing else does.
