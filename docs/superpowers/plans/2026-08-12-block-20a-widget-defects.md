# Block 20a — Widget defects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the two defects the owner reported on 2026-08-12 — a button
that appears twice with the same name on the song-request screen, and a
`missing_answers` refusal shown for a promotion form that was filled in.

**Architecture:** Item 1 is one optional prop on a local `Shell` component,
copied from the sibling panel that already has it, plus one message key in
three catalogues. Item 2 is a diagnosis before a fix: the existing e2e journey
is the reproduction of the ordinary case, and new pgTAP assertions decide
whether a second, latent path is real. Whatever the verdict, the panel gains
the ability to return the listener to the screen the refusal is about.

**Tech Stack:** Next.js 15 App Router (Server Actions), React 19
(`useActionState`), next-intl, Supabase/Postgres (pgTAP), Vitest, Playwright.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-block-20a-widget-defects-design.md`.
  Every decision below traces to a D-number in its §2.
- **Branch:** `block-19-whatsapp-entry`, the branch already checked out. Do not
  create a new branch and do not merge anything.
- **Language:** code, comments, commit messages and documentation in English.
  User-facing copy is in `messages/pt.json`, `en.json`, `es.json` and is
  translated in all three. Portuguese is the product's primary language.
- **Message keys are single-quoted literals at the call site, never composed.**
  `tests/unit/i18n/usage.test.ts` reads the AST for literal keys only, and
  next-intl renders the key itself when a message is absent. A composed key is
  checked by nothing. (This rule is already written into
  `src/app/(widget)/w/[publicKey]/identify-form.tsx`'s `refusal()` comment.)
- **Gate order — this is not optional.** Run `npm run db:reset` then
  `npm run db:test` **before** `npm run test:e2e` or `npm run test:isolation`,
  never after. The e2e and isolation suites leave rows behind that make pgTAP
  report failures which are not about the code.
- **Never recreate a SQL function by copying its body from an older
  migration.** This project has reverted later fixes that way. Read the live
  definition out of the database first — `select pg_get_functiondef('public.widget_promotions(text,uuid)'::regprocedure);` —
  and edit *that* text.
- **A migration must travel with the deploy.** This project has shipped code
  ahead of its migrations three times (Blocks 13a, 17b, 17c). If Task 3 runs,
  say so explicitly in the final report.
- Commit after every task. Do not push until Task 5.

---

## File Structure

**Modified:**

- `src/app/(widget)/w/[publicKey]/request-song.tsx` — the song-request panel.
  Its local `Shell` (line ~277) gains `closeLabel`; the note screen (the
  `chosen` branch, line ~161) passes it. Task 1.
- `messages/pt.json`, `messages/en.json`, `messages/es.json` — one new key,
  `widget.backToMenu`. Task 1.
- `tests/e2e/widget.spec.ts` — assertions on the note screen's two buttons
  (Task 1); nothing else in the file changes.
- `supabase/tests/42_widget_promotions.test.sql` — assertions proving whether a
  promotion whose question carries no alternatives is offered and then refuses
  a complete payload. Task 2.
- `src/lib/widget/promotion-mapping.ts` — gains `screensFor` and
  `firstUnansweredScreen`, both pure. Task 4.
- `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` — uses both, and moves
  the listener to the screen a `missing_answers` refusal is about. Task 4.
- `tests/unit/widget-promotion-mapping.test.ts` — unit tests for the two new
  functions. Task 4.
- `docs/superpowers/specs/2026-08-12-block-20a-widget-defects-design.md` —
  §4.3's verdict written down. Task 5.

**Created (only if Task 2 proves the path is reachable):**

- `supabase/migrations/0186_widget_promotions_require_options.sql` — Task 3.

---

## Task 1: The two "Voltar" on the song-request screen

**Files:**
- Modify: `src/app/(widget)/w/[publicKey]/request-song.tsx` (the `Shell`
  component, and the `chosen` branch that renders the note screen)
- Modify: `messages/pt.json`, `messages/en.json`, `messages/es.json`
- Test: `tests/e2e/widget.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the message key `widget.backToMenu`. No other task uses it.

**Background.** `request-song.tsx` has six `<Shell>` call sites. Five of them
render one button at the bottom and are unambiguous. The sixth — the `chosen`
branch, where the listener writes a note — also renders its own button row
inside the form (`Enviar pedido`, plus an outline button wired to
`setChosen(null)`), so two buttons reading `t('back')` are on screen at once
going to different places. D1: the **lower** one (the `Shell`'s) gets the name.

`enter-promotion.tsx` solved this in Block 19b with exactly this prop. Read its
`Shell` (around line 381) before starting — the new code should look like it
was written by the same hand.

- [ ] **Step 1: Write the failing assertions**

In `tests/e2e/widget.spec.ts`, inside the test named
`'a visitor identifies themselves from another origin, and asks for a song'`,
immediately after the line that fills the note
(`await widget.getByTestId('widget-song-note').fill(LISTENER_NOTE);`, ~line
624) and **before** the line that clicks send, insert:

```ts
  // Block 20a, item 1. THE NOTE SCREEN IS THE ONE PLACE TWO WAYS BACK ARE ON
  // SCREEN AT ONCE -- the outline button returns to the search, the Shell's
  // returns to the menu -- and until this block both of them read the same
  // word. Asserted by accessible NAME rather than by counting buttons: a
  // count of two passed before this change as well, which is the shape of
  // assertion that proves nothing.
  //
  // ENGLISH, because playwright.config.ts pins locale: 'en-US' for the whole
  // suite and this visitor has no profile, cookie or Accept-Language to
  // resolve anything else from. `exact: true` is load-bearing: without it
  // "Back" matches "Back to the menu" by substring and the first assertion
  // reports two.
  await expect(widget.getByRole('button', { name: 'Back', exact: true })).toHaveCount(1);
  await expect(
    widget.getByRole('button', { name: 'Back to the menu', exact: true }),
  ).toHaveCount(1);
```

**These assertions are in English on purpose, and an earlier draft of this plan
had them in Portuguese — which cannot pass.** `playwright.config.ts` pins
`locale: 'en-US'` for the whole suite, with a comment explaining that the suite
asserts roughly a hundred English strings and would otherwise render Portuguese
on any developer machine set to `pt-BR`. `resolveLocale` (`src/i18n/locales.ts`)
walks profile → cookie → `Accept-Language` → `DEFAULT_LOCALE`, and an anonymous
widget visitor has none of the first three. The product's primary language is
Portuguese; this one suite reads English. Both are true.

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx playwright test tests/e2e/widget.spec.ts -g "asks for a song"
```

Expected: FAIL. The first assertion receives `2` — both buttons on the note
screen are named "Back" today, which is the defect. The second receives `0`,
because nothing is named "Back to the menu" yet.

If the first assertion receives something other than `2`, stop and report it.
A `0` there would mean the panel is not rendering English, and the whole
assertion strategy needs rethinking before any code changes.

If the whole test fails earlier than the new assertions — before reaching the
note screen — stop and report it. That would be a broken journey, not this
defect, and Task 2 needs this test to be green for reasons of its own.

- [ ] **Step 3: Add the message key to all three catalogues**

The `widget` object in each file is sorted the same way in all three; place the
new key immediately after `back` so the three files stay comparable line by
line. `tests/unit/i18n/catalogue.test.ts` compares the three catalogues to each
other, so all three change in this one step or none do.

`messages/pt.json`:

```json
    "backToMenu": "Voltar ao menu",
```

`messages/en.json`:

```json
    "backToMenu": "Back to the menu",
```

`messages/es.json`:

```json
    "backToMenu": "Volver al menú",
```

- [ ] **Step 4: Give the Shell a closeLabel**

In `src/app/(widget)/w/[publicKey]/request-song.tsx`, add the prop to the local
`Shell`'s signature and destructuring. **Put it where `enter-promotion.tsx`
puts it** — after `publicKey`, immediately before `children` — rather than
anywhere this sentence might suggest: the mirror requirement is the binding
one, and the two panels are meant to read as one hand's work.

```tsx
  /**
   * What this panel's own way out is called, named by the caller.
   *
   * Block 20a, item 1, D1. The note screen draws its OWN "Voltar" inside the
   * form -- one step back, to the search -- so on that one screen this button
   * has to say where it goes instead. The other five call sites draw no button
   * of their own and pass nothing, which is why this is a prop rather than a
   * rename: "Voltar" is right everywhere it is unambiguous.
   *
   * The same prop, for the same reason and with the same default, as
   * enter-promotion.tsx's Shell.
   */
  closeLabel?: string;
```

and use it in the button:

```tsx
        <Button type="button" variant="ghost" onClick={onClose}>
          {closeLabel ?? t('back')}
        </Button>
```

- [ ] **Step 5: Pass it from the note screen only**

Still in `request-song.tsx`, in the `chosen` branch (~line 163), change:

```tsx
      <Shell title={t('requestASong')} onClose={onClose}>
```

to:

```tsx
      <Shell title={t('requestASong')} onClose={onClose} closeLabel={t('backToMenu')}>
```

Leave the other five `<Shell>` call sites alone — loading, error, cooldown,
recorded, and the search screen.

- [ ] **Step 6: Run the unit suite and the typechecker**

```bash
npm run test -- tests/unit/i18n
npm run typecheck
npm run lint
```

Expected: PASS. `usage.test.ts` is the one that would catch a key referenced in
code and absent from a catalogue; `catalogue.test.ts` is the one that would
catch the key landing in two files out of three.

- [ ] **Step 7: Run the e2e test and watch it pass**

```bash
npx playwright test tests/e2e/widget.spec.ts -g "asks for a song"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(widget\)/w/\[publicKey\]/request-song.tsx messages/pt.json messages/en.json messages/es.json tests/e2e/widget.spec.ts
git commit -F- <<'EOF'
fix(20a): the way back and the way out stop sharing a name

The note screen was the one place in the song panel with two buttons on it at
once -- the outline one steps back to the search, the Shell's leaves the errand
for the menu -- and both read "Voltar". A listener choosing between them was
choosing blind.

closeLabel is the prop enter-promotion.tsx's Shell already grew in Block 19b,
copied here with its default intact: the other five call sites draw no button
of their own, so "Voltar" stays right everywhere it is unambiguous.

The assertion is on accessible NAMES, with exact: true. Counting buttons would
have passed before this change too, and without exact the name "Voltar" matches
"Voltar ao menu" by substring.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: The reproduction, and the verdict on item 2

**Files:**
- Modify: `supabase/tests/42_widget_promotions.test.sql`
- Read only: `tests/e2e/widget.spec.ts`

**Interfaces:**
- Consumes: Task 1's green e2e run.
- Produces: a verdict — *reachable* or *not reachable* — that Task 3 branches
  on. Write it into the task report in those words.

**Background.** Spec §4.2 names two candidate causes and §4.3 says which
evidence decides between them.

*Candidate (a), a stale production build.* The screenshot shows the message on
a screen whose primary button reads "Continuar" (`t('next')`, so not the last
screen) and a bottom button reading "Voltar". On this branch and on
`origin/main` the message is gated `state.status === 'refused' && last`, and
the promotion walk's bottom button reads "Outras promoções". Neither detail can
be produced by the code as it stands. The owner confirmed the screenshots come
from `pulchatx.com`.

*Candidate (b), a question with alternatives and no options.* `widget_promotions`
(0173) returns `'[]'::jsonb` as that question's options; the panel draws such a
question as nothing at all (a documented choice in `enter-promotion.tsx`'s
`Question`); the listener taps through a blank screen; and the door counts a
`question` step the payload does not answer, answering `missing_answers` for a
form that looked complete. No constraint requires a `QUIZ` or
`MULTIPLE_CHOICE` question to have even one option row — `promotion_question_options`
(0041) constrains the options that exist, not their number.

- [ ] **Step 1: Confirm the ordinary walk works on this branch**

The existing e2e journey already walks consent → one requested field → a
question **with** options → send, and asserts the entry reaches the database.
That is the reproduction of the ordinary configuration, and it needs to be run
rather than assumed.

```bash
npx playwright test tests/e2e/widget.spec.ts -g "asks for a song"
```

Expected: PASS (it passed at the end of Task 1). Record in the task report:
*"the ordinary promotion walk completes on this branch"*. That is the evidence
for candidate (a).

- [ ] **Step 2: Write the failing pgTAP assertions**

Open `supabase/tests/42_widget_promotions.test.sql`. At the end of the file,
**before** the final `select * from finish();` / `rollback;` lines, add a new
numbered section. Follow the file's own fixture style: literal uuids in the
`00000000-0000-0000-0000-0000000004xx` range, and a listener who has answered
nothing yet.

```sql
-- ---------------------------------------------------------------------------
-- 20-22. Block 20a, item 2, candidate (b): a question with alternatives and no
--        alternatives in it.
--
-- 0041 constrains the option rows that exist -- not ESSAY, correct only on
-- QUIZ, unique positions -- and says nothing about how many there must be,
-- because a CHECK cannot count rows in another table. So a promotion can carry
-- a MULTIPLE_CHOICE question with zero options, and 0173 answers '[]' for it.
--
-- The panel draws that question as NOTHING (enter-promotion.tsx's Question, on
-- the grounds that an empty screen beats a text box whose every answer trips
-- participation_answers_shape). The listener taps through a blank screen, and
-- the door counts a step the payload cannot answer.
--
-- These three assertions establish whether that path is reachable at all. What
-- they must NOT do is assert the fix: 20 and 21 describe today's behaviour, and
-- Task 3 -- if it runs -- rewrites them.
-- ---------------------------------------------------------------------------
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000420', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo com pergunta sem alternativas',
   now() - interval '1 day', now() + interval '7 days',
   false, array['city']::public.promotion_requested_field[],
   'Válido para maiores de 18 anos.', true);

-- MULTIPLE_CHOICE, and deliberately no promotion_question_options rows.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt)
values
  ('00000000-0000-0000-0000-000000000421', '00000000-0000-0000-0000-000000000420',
   '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   1, 'MULTIPLE_CHOICE', 'Qual a sua rádio favorita?');

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000422', '00000000-0000-0000-0000-000000000401',
   'Optionless Listener', '+5511999993333');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000422', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

-- 20. The promotion IS offered to the widget today.
select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000422') -> 'promotions') e
    where (e ->> 'id') = '00000000-0000-0000-0000-000000000420'),
  1::bigint, 'a promotion whose only question has no alternatives is offered');

-- 21. And its question arrives with an empty option list, which is what the
--     panel draws as nothing.
select is(
  (select e -> 'questions' -> '00000000-0000-0000-0000-000000000421'
     from jsonb_array_elements(
       public.widget_promotions('pw_promostationa012345678',
                                '00000000-0000-0000-0000-000000000422') -> 'promotions') e
    where (e ->> 'id') = '00000000-0000-0000-0000-000000000420'),
  '[]'::jsonb, 'and its question carries no alternatives for the panel to draw');

-- 22. THE ASSERTION THIS SECTION EXISTS FOR. Every requested field answered,
--     consent given, and the entry is still refused -- for a question the
--     listener was never shown.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000422',
     '00000000-0000-0000-0000-000000000420', true,
     '{"city": "São Paulo"}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'missing_answers',
  'and a complete payload is refused for the question nobody could answer');
```

Bump the plan count at the top of the file. It currently reads `select plan(19);`
— if the file has grown since, read the current number and add 3 to whatever is
actually there rather than to 19.

- [ ] **Step 3: Run the pgTAP suite**

```bash
npm run db:reset
npm run db:test
```

Expected: PASS, all three new assertions included. **A pass here is the
finding, not a formality** — it means candidate (b) is reachable and the widget
can refuse a listener for a question it never showed them.

If assertion 22 comes back with something other than `missing_answers` — most
likely `promotion_closed`, if a filter this plan did not find already excludes
such a promotion — then the path is **not reachable**, candidate (b) is
eliminated, and the verdict is (a). Adjust assertions 20–22 to describe
whatever the door actually does, keep them (they are worth having either way),
and record the verdict.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/42_widget_promotions.test.sql
git commit -F- <<'EOF'
test(20a): a question with alternatives, and no alternatives in it

Item 2's second candidate, established rather than argued. 0041 constrains the
option rows that exist and cannot constrain how many there are, so a
MULTIPLE_CHOICE question with zero options is a legal promotion; 0173 answers
'[]' for it; the panel draws it as nothing; and the door then refuses a payload
that answered every field, for a question the listener was never shown.

These three assertions describe TODAY'S behaviour on purpose. They are the
diagnosis, not the fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: Report the verdict**

State it in the task report in one of these two forms, verbatim:

- *"Verdict: reachable. Candidate (b) is a live defect; Task 3 runs."*
- *"Verdict: not reachable. Candidate (a) stands; Task 3 is skipped, and item 2
  closes as a pending deployment."*

---

## Task 3: Stop offering a promotion nobody can complete

**Run this task only if Task 2's verdict is *reachable*.** If it is *not
reachable*, skip to Task 4 and say in the final report that item 2 resolved to
a pending deployment with no code change.

**Files:**
- Create: `supabase/migrations/0186_widget_promotions_require_options.sql`
- Modify: `supabase/tests/42_widget_promotions.test.sql` (assertions 20 and 22
  now describe the repaired behaviour)

**Interfaces:**
- Consumes: Task 2's fixtures (promotion `…420`, question `…421`, listener
  `…422`).
- Produces: nothing other tasks read.

**The shape of the fix.** Spec §4.3: the fix belongs where the options go
missing, not in the panel that faithfully draws nothing. `widget_promotions`
already refuses to offer a promotion with no rules — D3, and the door
`widget_enter_promotion` **restates that condition rather than trusting the
list**, in its own words: *"the same two conditions the list applies, restated
rather than trusted"*. This adds a third condition in both places, in exactly
that spirit: a promotion carrying a question that has alternatives but no
alternative rows is not offered, and is refused as `promotion_closed` if
somebody submits against it anyway.

A misconfigured promotion therefore becomes invisible on the web rather than
enterable-and-then-refused — the same treatment, for the same reason, that a
promotion with no rules text already gets.

- [ ] **Step 1: Read the live definitions**

Do **not** copy the bodies out of 0171 and 0173. This project has reverted
later fixes exactly that way.

```bash
npx supabase db psql -c "select pg_get_functiondef('public.widget_promotions(text,uuid)'::regprocedure);"
npx supabase db psql -c "select pg_get_functiondef('public.widget_enter_promotion(text,uuid,uuid,boolean,jsonb,jsonb)'::regprocedure);"
```

If `npx supabase db psql` is not available in this environment, connect with
`psql` to the local database directly — `scripts/db-reset.mjs` shows how the
connection string is assembled. Save both definitions; they are the base text
the migration edits.

- [ ] **Step 2: Update assertions 20 and 22 to describe the fix**

**First, the section comment.** Task 2's header for this section says *"20 and
21 describe today's behaviour, and Task 3 — if it runs — rewrites them"*. All
three assertions are about to be rewritten, and once they are, that sentence is
both stale and wrong. Replace it with what is then true:

```sql
-- These three described the defect before 0186 closed it. They now describe
-- the repair: the promotion is absent, its question is absent with it, and a
-- submission against it is refused as closed rather than as the listener's
-- fault.
```

Then, in `supabase/tests/42_widget_promotions.test.sql`, change assertion 20's
expectation from `1::bigint` to `0::bigint` and its description:

```sql
-- 20. The promotion is NOT offered. Same treatment, for the same reason, as a
--     promotion with no rules text (D3): a listener is not shown a door that
--     can only close on them.
select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000422') -> 'promotions') e
    where (e ->> 'id') = '00000000-0000-0000-0000-000000000420'),
  0::bigint, 'a promotion whose only question has no alternatives is not offered');
```

Assertion 21 no longer has a promotion to read a question out of. Replace it
with the negative that matters — the whole payload no longer mentions it:

```sql
-- 21. And nothing about it leaks into the payload by another route.
select is(
  (select public.widget_promotions('pw_promostationa012345678',
                                   '00000000-0000-0000-0000-000000000422')::text
     like '%00000000-0000-0000-0000-000000000421%'),
  false, 'and its question is absent from the payload entirely');
```

Assertion 22's expected reason changes from `missing_answers` to
`promotion_closed`:

```sql
-- 22. And a submission against it -- from a crafted payload, or from a browser
--     that had the list open before the options were removed -- is refused as
--     closed rather than as the listener's fault.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000422',
     '00000000-0000-0000-0000-000000000420', true,
     '{"city": "São Paulo"}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'promotion_closed',
  'and a submission against it is refused as closed, not as the listener''s fault');
```

- [ ] **Step 3: Run the pgTAP suite and watch the three fail**

```bash
npm run db:reset
npm run db:test
```

Expected: FAIL — assertion 20 gets `1` where `0` is expected, 21 gets `true`
where `false` is expected, 22 gets `missing_answers` where `promotion_closed`
is expected.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0186_widget_promotions_require_options.sql`. Start
from the live definitions saved in Step 1 and add **one** condition to each.
The header:

```sql
-- supabase/migrations/0186_widget_promotions_require_options.sql

-- Block 20a, item 2. A promotion that cannot be completed is no longer
-- offered.
--
-- 0041 constrains the option rows that exist -- not ESSAY, correct only on
-- QUIZ, unique positions -- and cannot constrain how MANY there are, because a
-- CHECK may not count rows in another table. So a MULTIPLE_CHOICE or QUIZ
-- question with zero options is a legal promotion, 0173 answers '[]' for it,
-- and enter-promotion.tsx draws such a question as nothing at all -- which is
-- the right call there (a text box would trip participation_answers_shape,
-- 0052, on every answer) and leaves the listener tapping through a blank
-- screen into a refusal they cannot act on.
--
-- SAME TREATMENT AS A PROMOTION WITH NO RULES, and that is the argument: D3
-- already decided that a promotion the widget cannot present honestly is
-- absent rather than broken on screen. This is the second thing that makes a
-- promotion impossible to present, and it gets the same answer.
--
-- RESTATED IN THE DOOR, NOT TRUSTED FROM THE LIST -- the words are
-- widget_enter_promotion's own, about the two conditions it already restates.
-- A browser holding a list drawn before the options were deleted would
-- otherwise submit against a promotion this migration just hid.
--
-- WHATSAPP IS DELIBERATELY UNTOUCHED. The bot composes its buttons from the
-- question row when it sends the message, so an optionless question fails
-- there in a different place and in a different way; that door is not what the
-- owner reported and is not repaired here.
```

Then `create or replace function public.widget_promotions(...)` — the live text
— with this condition appended to the `where` clause that already filters on
`p.rules`:

```sql
         and not exists (
           select 1
             from public.promotion_questions q
            where q.promotion_id = p.id
              and q.kind <> 'ESSAY'
              and not exists (
                select 1 from public.promotion_question_options o
                 where o.question_id = q.id))
```

And `create or replace function public.widget_enter_promotion(...)` — the live
text — with the identical condition appended to the `if not exists (select 1
from public.promotions p where …)` block that already restates the list's
conditions.

Update both `comment on function` statements to mention the new condition, in
the style of the ones already there. Re-issue the `revoke`/`grant` pair for
both functions at the end, exactly as 0171 does — `create or replace` does not
reset privileges, but restating them keeps the file readable as the whole
truth about these two doors.

- [ ] **Step 5: Run the pgTAP suite and watch it pass**

```bash
npm run db:reset
npm run db:test
```

Expected: PASS, including the earlier assertions in file 42 — particularly the
ones about the promotion that *is* offered, which must not have been caught by
the new filter. That promotion (`…405`) has no questions at all, so the `not
exists` is trivially true for it; if it disappeared, the condition is inverted.

- [ ] **Step 6: Regenerate the database types**

```bash
npm run db:types
```

Expected: no change, or a trivial one. `create or replace` on two existing
functions with unchanged signatures should leave
`src/lib/supabase/database.types.ts` alone. If it does change, include it in
the commit.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0186_widget_promotions_require_options.sql supabase/tests/42_widget_promotions.test.sql src/lib/supabase/database.types.ts
git commit -F- <<'EOF'
fix(20a): a promotion nobody can finish is not offered

A MULTIPLE_CHOICE or QUIZ question with zero option rows is a legal promotion
-- 0041 constrains the options that exist and cannot count them -- and the
widget drew such a question as nothing, tapped straight past it, and refused
the entry with missing_answers for a form that looked complete.

Same treatment as a promotion with no rules, which is D3's decision applied to
the second thing that makes a promotion impossible to present honestly: it is
absent rather than broken on screen. Restated inside widget_enter_promotion
rather than trusted from the list, in the words that function already uses
about the two conditions it restates today.

WhatsApp is untouched: the bot builds its buttons from the question row at send
time, so an optionless question fails there in a different place, and that door
is not what was reported.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: The refusal is shown where the refusal is about

**Files:**
- Modify: `src/lib/widget/promotion-mapping.ts`
- Modify: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`
- Test: `tests/unit/widget-promotion-mapping.test.ts`

**Interfaces:**
- Consumes: `WidgetStep` from `src/lib/widget/promotion-mapping.ts`.
- Produces:
  - `screensFor(steps: WidgetStep[]): WidgetStep[][]`
  - `firstUnansweredScreen(screens: WidgetStep[][], fields: Record<string, string>, answers: Record<string, string>): number | null`

**Background.** D4, and it ships whatever Task 2 decided. "Faltou alguma coisa.
Volte e confira suas respostas." asks the listener to go and look, on a walk
that can be four screens long, when the panel already holds every answer and
knows which screen each step is on.

Two pieces move into `promotion-mapping.ts`, which exists precisely so logic
like this is importable — a `'use server'` module may export nothing but async
functions, so anything left in the panel is testable only by a browser. The
screen layout moves with the search, because a copy of the layout in each place
is two places for them to disagree about which screen index means what.

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/unit/widget-promotion-mapping.test.ts`, and extend the import
on line 2 to bring in the two new functions:

```ts
describe('screensFor', () => {
  /**
   * The walk is not a chat. The bot asks one thing per message because a
   * conversation has no other shape; a page groups every requested field onto
   * one screen, which is what somebody filling in a form expects.
   */
  it('puts consent alone, every field together, and one question per screen', () => {
    expect(
      screensFor([
        { kind: 'consent' },
        { kind: 'field', field: 'city' },
        { kind: 'field', field: 'address' },
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
        { kind: 'question', questionId: 'q2', questionKind: 'ESSAY' },
      ]),
    ).toEqual([
      [{ kind: 'consent' }],
      [
        { kind: 'field', field: 'city' },
        { kind: 'field', field: 'address' },
      ],
      [{ kind: 'question', questionId: 'q1', questionKind: 'QUIZ' }],
      [{ kind: 'question', questionId: 'q2', questionKind: 'ESSAY' }],
    ]);
  });

  it('draws no field screen at all when nothing is asked for', () => {
    expect(screensFor([{ kind: 'consent' }])).toEqual([[{ kind: 'consent' }]]);
  });
});

describe('firstUnansweredScreen', () => {
  const walk = screensFor([
    { kind: 'consent' },
    { kind: 'field', field: 'city' },
    { kind: 'field', field: 'address' },
    { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
  ]);

  it('answers null when every step has something in it', () => {
    expect(
      firstUnansweredScreen(walk, { city: 'São Paulo', address: 'Rua X, 1' }, { q1: 'o1' }),
    ).toBeNull();
  });

  it('finds the field screen when one field is empty', () => {
    expect(firstUnansweredScreen(walk, { city: 'São Paulo' }, { q1: 'o1' })).toBe(1);
  });

  /**
   * The same rule the door applies: `nullif(btrim(...), '')` in 0171, so
   * whitespace is not an answer on either side of the wire.
   */
  it('treats whitespace as no answer, exactly as the door does', () => {
    expect(
      firstUnansweredScreen(walk, { city: '   ', address: 'Rua X, 1' }, { q1: 'o1' }),
    ).toBe(1);
  });

  // Index 2, not 3: this walk is three screens — consent (0), both fields
  // together (1), the one question (2). `screensFor` puts every field on ONE
  // screen, so four steps do not make four screens.
  it('finds the question screen when the fields are done and the answer is not', () => {
    expect(
      firstUnansweredScreen(walk, { city: 'São Paulo', address: 'Rua X, 1' }, {}),
    ).toBe(2);
  });

  it('answers with the FIRST unanswered screen, not the last', () => {
    expect(firstUnansweredScreen(walk, {}, {})).toBe(1);
  });

  /**
   * Consent is never this function's business. Declining is not a
   * missing_answers refusal at all -- the door writes a promotion_refusals row
   * and answers `refused` -- so a walk whose only screen is consent has
   * nothing here to find.
   */
  it('never points at the consent screen', () => {
    expect(firstUnansweredScreen(screensFor([{ kind: 'consent' }]), {}, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test -- tests/unit/widget-promotion-mapping.test.ts
```

Expected: FAIL — `screensFor is not a function` (the import resolves to
`undefined`).

- [ ] **Step 3: Implement both functions**

Append to `src/lib/widget/promotion-mapping.ts`:

```ts
/**
 * The step list collapsed into the screens the panel walks.
 *
 * MOVED HERE FROM `enter-promotion.tsx` (Block 20a) so that
 * `firstUnansweredScreen` below and the panel agree on what a screen index
 * means. Two copies of this layout would be two places for them to drift, and
 * the drift would show up as the panel jumping to the wrong screen — which is
 * worse than not jumping at all.
 *
 * Consent alone, because it gates everything after it; then every requested
 * field on one screen, which is what somebody filling in a form expects; then
 * one question per screen, because each carries its own alternatives.
 */
export function screensFor(steps: WidgetStep[]): WidgetStep[][] {
  const fieldSteps = steps.filter((step) => step.kind === 'field');
  const questions = steps.filter((step) => step.kind === 'question');
  return [
    [{ kind: 'consent' } as WidgetStep],
    ...(fieldSteps.length > 0 ? [fieldSteps] : []),
    ...questions.map((question) => [question]),
  ];
}

/**
 * The first screen still holding a step with nothing in it, or null.
 *
 * Block 20a, D4. `missing_answers` says something was skipped and not which
 * thing, on a walk that can be four screens long — so the panel, which holds
 * every answer, works out where to send the listener rather than asking them
 * to search.
 *
 * A COURTESY, NEVER A GUARD. The door recomputes the step list and remains the
 * only authority on what a promotion asks (0171's own comment). This function
 * answering null while the door refuses is a real and informative state: it
 * means the screen and the door disagree about what was asked, which is
 * exactly the shape of the defect this block investigated, and the panel
 * leaves the listener where they are with the message on screen rather than
 * smoothing it over.
 *
 * CONSENT IS NOT CHECKED. Declining is not a missing_answers refusal — the
 * door writes a promotion_refusals row and answers `refused`, which the panel
 * renders as its own state.
 *
 * `btrim`-equivalent on purpose: 0171 tests `nullif(btrim(coalesce(...)), '')`,
 * so whitespace is not an answer on either side of the wire.
 */
export function firstUnansweredScreen(
  screens: WidgetStep[][],
  fields: Record<string, string>,
  answers: Record<string, string>,
): number | null {
  const index = screens.findIndex((screen) =>
    screen.some((step) => {
      if (step.kind === 'field') return (fields[step.field] ?? '').trim() === '';
      if (step.kind === 'question') return (answers[step.questionId] ?? '').trim() === '';
      return false;
    }),
  );
  return index === -1 ? null : index;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test -- tests/unit/widget-promotion-mapping.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Use both from the panel**

In `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`:

Extend the import from `@/lib/widget/promotion-mapping` to include
`firstUnansweredScreen` and `screensFor`.

Replace the `screens` memo (~line 132) with a call to the shared function,
keeping a shortened comment that points at where the layout now lives:

```tsx
  /**
   * The step list collapsed into screens — `screensFor` (promotion-mapping.ts),
   * shared with `firstUnansweredScreen` so the two cannot disagree about what
   * a screen index means. Derived rather than stored, so a promotion chosen
   * twice cannot leave a stale screen count behind.
   */
  const screens = useMemo(() => (chosen ? screensFor(chosen.steps) : []), [chosen]);
```

Add, immediately after the `screens` memo, the state and effect that act on a
refusal:

```tsx
  /**
   * Which screen a `missing_answers` refusal was shown on, so the message can
   * follow the listener there.
   *
   * The message is otherwise gated on `last` — because a refusal rendered
   * under every screen the listener walks back through reads as if each of
   * them were wrong, which is what happened on 2026-08-11. Moving the listener
   * without moving the message would land them on a silent screen; this is the
   * one screen other than the last where it has something to say.
   */
  const [flagged, setFlagged] = useState<number | null>(null);

  /**
   * `state`, ACTED ON ONCE — the same identity guard `identify-form.tsx` uses
   * for `handledRequest`, and for the same reason. `fields` and `answers` are
   * in this effect's dependencies, so without the guard every keystroke after
   * a refusal would drag the listener back to the screen they had just left.
   */
  const [handledRefusal, setHandledRefusal] = useState<EnterState>(IDLE);
  useEffect(() => {
    if (state === handledRefusal) return;
    setHandledRefusal(state);
    if (state.status !== 'refused' || state.reason !== 'missing_answers') return;

    const target = firstUnansweredScreen(screens, fields, answers);
    if (target === null) return;
    setScreen(target);
    setFlagged(target);
  }, [state, handledRefusal, screens, fields, answers]);
```

**Both hooks must go before the `if (state.status === 'entered' …)` early
return** — which they do if they sit immediately after the `screens` memo,
since that memo is already above it. A hook below an early return is a
different number of hooks on different renders, and React throws.

Then widen the message's gate (~line 238) from `last` to `last || screen === flagged`:

```tsx
          {state.status === 'refused' && (last || screen === flagged) ? (
```

And clear `flagged` in both navigation buttons, so walking away from the
flagged screen takes the message with it — `setFlagged(null)` alongside the
existing `setScreen` call in the "next" button and in the "back" button.

- [ ] **Step 6: Run the typechecker and linter**

```bash
npm run typecheck
npm run lint
```

Expected: PASS. `useEffect` and `useState` are already imported in this file
(line 3), so no import line changes beyond the `promotion-mapping` one — check
rather than assume.

`answersFor` and `decideAutoOpen` are still imported and still used; the new
import adds `firstUnansweredScreen` and `screensFor` to that same statement.

- [ ] **Step 7: Run the promotion journey end to end**

```bash
npx playwright test tests/e2e/widget.spec.ts -g "asks for a song"
```

Expected: PASS. The journey enters a promotion successfully, so this proves the
refactor did not change the happy path — the screen layout is now computed by
`screensFor`, and a mistake there would break the walk itself.

- [ ] **Step 8: Commit**

```bash
git add src/lib/widget/promotion-mapping.ts src/app/\(widget\)/w/\[publicKey\]/enter-promotion.tsx tests/unit/widget-promotion-mapping.test.ts
git commit -F- <<'EOF'
fix(20a): the refusal goes to the screen it is about

"Faltou alguma coisa. Volte e confira suas respostas." asked a listener to go
and look, on a walk four screens long, while the panel held every answer and
knew which screen each step was on.

screensFor and firstUnansweredScreen move into promotion-mapping.ts, the module
that exists to be importable -- a 'use server' file may export nothing but
async functions, so anything left in the panel is testable only by a browser.
The screen LAYOUT moves with the search on purpose: two copies of it would be
two places to disagree about what a screen index means.

A courtesy, not a guard. The door stays the only authority on what a promotion
asks, and a walk where nothing is missing but the door still refuses leaves the
listener where they are with the message on screen -- that disagreement is
worth being visible.

The message's gate widens from `last` to `last || screen === flagged` so the
listener does not land on a silent screen, and `flagged` clears on any manual
navigation, which keeps the 2026-08-11 behaviour it was narrowed for: a refusal
must not appear under every earlier screen as if each of them were wrong.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: The gates, the verdict on the record, and the push

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-block-20a-widget-defects-design.md`

- [ ] **Step 1: Run every gate, in the order that works**

```bash
npm run typecheck
npm run lint
npm run test
npm run db:reset
npm run db:test
npm run seed:branding
npm run test:e2e
npm run test:isolation
```

`db:test` **before** `test:e2e` and `test:isolation`, never after. Reversing
them leaves rows behind that make pgTAP report failures which are not about the
code, and this project has chased that twice.

`seed:branding` **after `db:reset`, before the e2e**, and it is not optional:
`db:reset` empties Storage, and `login.spec.ts` asserts the branding image is
there. CI already runs it for exactly this reason. Omitting it produces one
failing spec that has nothing to do with the change under test.

**The isolation suite crashes about two runs in five, and has since Block 4b.**
Six crashes in fifteen full runs, on six different files, no repeats, no cause
found — the suspected trigger was removed and the crash carried on. What
`scripts/verify-isolation-suite.mjs` guarantees is that such a run can never be
*mistaken* for a green one: it reads the manifest, the JSON reporter and
vitest's own summary line, and fails loudly naming what is missing. Its message
"do not re-run past this" means **do not accept this run as proof** — not "never
run it again".

So: a `Worker exited unexpectedly` crash is a re-run, from a clean database, and
the second result is the one that counts. What is NOT allowed, ever, is
weakening the guard or running the suite repeatedly until something goes green
and reporting that. If it crashes twice in a row on the same file, that is a
different animal — stop and report it, because the historical flake has never
repeated a file.

Expected: all green. Report the actual output of any failure rather than
re-running until it passes.

- [ ] **Step 2: Write the verdict into the spec**

In §4.3 of
`docs/superpowers/specs/2026-08-12-block-20a-widget-defects-design.md`, replace
the two conditional bullets with what actually happened — which cause it was,
what evidence decided it, and what shipped. A spec that still poses the
question after the question is answered is the kind of document that gets
believed later.

If the verdict was *not reachable*, say plainly that item 2 needs a deployment
of what is already merged and that no code change addresses it, so nobody reads
the block's commits and concludes the screenshot was fixed.

- [ ] **Step 3: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-08-12-block-20a-widget-defects-design.md
git commit -F- <<'EOF'
docs(20a): §4.3 records which cause it was

The spec posed a question and committed to a reproduction rather than a fix.
This is the answer, written where the question was asked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: Push**

```bash
git push
```

The branch already has an open PR (#64). This adds to it rather than opening a
second one.

- [ ] **Step 5: Report**

State, in the final report:

1. Which cause item 2 turned out to be, and the evidence.
2. Whether Task 3 ran — and if it did, **that migration 0186 exists and must
   reach the hosted database with the deploy.** This project has shipped code
   ahead of its migrations three times.
3. That the deployed build at `pulchatx.com` is behind `origin/main`, which is
   the finding behind item 2 regardless of the verdict, and that items 1 and 2
   both need a deploy before the owner can see any of it.
