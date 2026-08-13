# Block 20a — Two buttons called the same thing, and a refusal nobody earned

**Status:** design agreed with the owner, 2026-08-12.
**Extends:** Blocks 17b and 17c, whose two panels this repairs. Nothing new is
built here.
**First of three:** the owner's list of 2026-08-12 carries nine items. This
block takes items 1 and 2 — the two defects. Items 3, 4, 8 and 9 (navigation)
become Block 20b; items 5, 6 and 7 (the catalogue as three screens) become
Block 20c. §6 records that split so the two blocks that follow are not
re-derived from scratch.

---

## 1. What this is for

Two complaints, from the owner, about the widget a listener reaches from
WhatsApp. Both are about the same thing from opposite ends: a screen that tells
the listener something untrue.

**The first is a button that appears twice.** On the screen where a listener
writes a note and sends a song request, there are two buttons reading "Voltar",
one above the other, and they go to different places. The upper one returns to
the search; the lower one abandons the request and returns to the menu. A
listener choosing between them is choosing blind.

**The second is a refusal for a form that was filled in.** A listener who is
not yet in the database walks a promotion, types an address, a city, a
neighbourhood and a date of birth, and reads *"Faltou alguma coisa. Volte e
confira suas respostas."* under a form with nothing missing from it.

Neither is a new capability. The first is one prop the sibling panel already
has. The second is not yet a fix at all — it is a reproduction, and §4 says why
that has to come first.

---

## 2. Decisions

The owner's, taken 2026-08-12.

**D1 — The lower button is the one that gets a name.** On the note screen it
becomes "Voltar ao menu"; the upper one stays "Voltar". The rule this states,
and which the panels can be read against from now on: *the lower button always
names where it goes, the upper one always means one step back inside the errand
in progress.* The rejected alternative was to name the upper button instead
("Escolher outra"), mirroring `enter-promotion.tsx`'s own "Outras promoções" —
rejected because in that panel the lower button IS the one that leaves, and
naming a different button in each of two panels that sit behind the same menu
is the confusion this item exists to end, moved rather than removed.

**D2 — The block is split, and this one ships alone.** The two defects are on
the screen listeners actually use, and the seven items after them are not. This
block reaches production without waiting for three new catalogue screens.

**D3 — Item 2 is reproduced before it is fixed.** §4 has the two candidate
causes and why guessing between them from a screenshot would be a coin toss.
The block commits to the reproduction, and to whichever of the two fixes it
proves — not to a fix chosen in advance.

**D4 — One improvement ships whichever cause it turns out to be.** When the
door answers `missing_answers`, the panel returns the listener to the first
screen still holding an unanswered step, instead of only printing a sentence.
§4.3 has the reasoning; it is small, and it is the only part of item 2 that is
worth doing even if the reproduction comes back clean.

---

## 3. Item 1 — the two "Voltar"

### 3.1 What is actually there

`src/app/(widget)/w/[publicKey]/request-song.tsx` has a local `Shell` that
draws a title, its children, and a row of buttons at the bottom. The bottom row
always renders `t('back')` wired to `onClose`, which returns to the widget
menu. The note screen — the `chosen` branch — draws its own row inside the
form: `Enviar pedido` (submit) and an outline button reading `t('back')` wired
to `setChosen(null)`, which returns to the search.

Both read "Voltar". Both are visible at once, on that one screen only: every
other screen in the panel draws no button of its own, so the `Shell`'s is
unambiguous there.

### 3.2 The fix

`enter-promotion.tsx`'s `Shell` already solved this in Block 19b, with an
optional `closeLabel` prop whose own comment names the date this was first
seen. The same prop comes to `request-song.tsx`'s `Shell`:

- `closeLabel?: string`, defaulting to `t('back')` when absent, so the five
  `<Shell>` call sites that pass nothing — loading, error, cooldown, recorded
  and the search screen — are untouched;
- the `chosen` branch passes `t('backToMenu')`.

A new message key `backToMenu` is added to `messages/pt.json`, `en.json` and
`es.json` under `widget`. Portuguese: "Voltar ao menu". English: "Back to the
menu". Spanish: "Volver al menú".

The key is spelled as a single-quoted literal in the call, never composed —
`tests/unit/i18n/usage.test.ts` matches literal keys only, and next-intl
renders the key itself for a missing message. That rule is already written
into `identify-form.tsx`'s own comment and is restated here because this block
adds a key.

### 3.3 What proves it

`tests/e2e/widget.spec.ts` already drives the song request through to the note
screen. The assertion this block adds is about accessible names rather than
about a count of buttons: on the note screen, exactly one control is named
"Voltar" and exactly one is named "Voltar ao menu", and following the second
one lands on the menu. Asserting "two buttons exist" would have passed before
this change too.

---

## 4. Item 2 — the refusal for a completed form

### 4.1 What the door actually checks

`widget_enter_promotion` (0171) recomputes the step list with
`whatsapp_conversation_steps(promotion, member)` and answers `missing_answers`
in exactly two places: a `field` step with no non-blank value in `p_fields`,
and a `question` step with no entry in `p_answers`.

Both checks run **before** `apply_member_field_values`. This rules out a whole
family of suspects that the screenshot invites: the date typed as `03/10/1978`
into a field that maps to `members.birth_date` (`member_field_value`, 0065,
maps `age` → `birth_date::text`) cannot produce this message, because nothing
has tried to parse it yet when the message is decided. Neither can the CPF
field, which maps to `cpf_hash`. Whatever this is, it is a step the door
counts and the payload does not carry.

### 4.2 The two candidates

**(a) Production is running a build older than `origin/main`.** Two of the
screenshot's details are signatures of code that has since changed:

- the message appears on a screen whose primary button reads "Continuar",
  which is `t('next')` — so it is not the last screen. On `origin/main` the
  message is gated `state.status === 'refused' && last`, and cannot render
  there at all;
- the bottom button of the promotion walk reads "Voltar". On `origin/main`
  that screen passes `closeLabel={t('otherPromotions')}` — "Outras promoções".

`origin/main` is the merge of PR #63; the working branch carries twelve further
commits (PR #64) that are not in it. The owner confirmed the screenshots are
from `pulchatx.com`. If the deployed build predates the fixes above, both
details are explained without a defect existing today, and item 2 is an
implantação rather than a conserto. The project has shipped code ahead of its
migrations three times (Blocks 13a, 17b, 17c); a deploy lagging the branch is
in character for this system.

**(b) A question with alternatives arrived without its options.** The panel
draws such a question as *nothing at all* — a deliberate, documented choice in
`enter-promotion.tsx`, on the grounds that an empty screen followed by the
door's own refusal beats a text box whose every answer trips
`participation_answers_shape` (0052). The listener taps through a blank screen
without noticing, submits, and the door counts a `question` step the payload
does not answer: `missing_answers`, for a form that looks complete.

This cause is not new-listener-specific, and that is the point that makes it
survive the screenshot. It refuses everybody equally. A listener already in the
database is asked for no fields at all — `whatsapp_conversation_steps` only
emits steps for values that are empty or stale — so their walk is consent, then
the question, and the message lands somewhere else entirely. The new listener
is simply the only one with a fields screen to photograph.

### 4.3 The reproduction, and what follows from it

Against the current branch, with a promotion carrying both requested fields and
at least one question with alternatives, entered as a listener with no prior
record: it reproduced. Both candidates turned out to be true in different
senses, and both are recorded here rather than one — a reader who found only
the one that explains the screenshot would draw the wrong conclusion about the
other.

**Candidate (a) is the explanation for the owner's screenshot, and it is the
only one.** The e2e journey that walks an ordinary promotion end to end passes
on this branch, which is only possible if nothing in today's code can produce
the screenshot's own signatures — a "Continuar" primary button on a screen
that is not the last one, "Voltar" as the promotion walk's bottom button.
`origin/main` is still the merge of PR #63; this branch's fixes have not
reached it. The deployed build at `pulchatx.com` is behind `origin/main`, and
nothing in Block 20a changes that — closing it needs a deployment, not another
line of code. This is said plainly so that reading this block's commits is not
mistaken for the screenshot being fixed: it is not, until `origin/main` — this
branch included — is deployed.

**Candidate (b) is a real, provable defect, and it is now closed — but it did
not produce the screenshot.** Assertion 22 answered every requested field and
gave consent, and `widget_enter_promotion` still returned `missing_answers` —
a complete payload, refused, exactly as §4.2 describes. The mechanism is not a
guess: `whatsapp_conversation_steps` (0066) builds a question step for every
row in `promotion_questions` with no join to `promotion_question_options`, so a
question with zero alternatives still produces a step the payload has no way to
answer. Verdict, verbatim from the diagnosis: *"reachable. Candidate (b) is a
live defect; Task 3 runs."* It ran: migration `0186` closes the path at both
doors, `widget_promotions` stops offering a promotion that carries a
non-`ESSAY` question with no option rows, and `widget_enter_promotion` restates
the same condition and refuses a submission against one as `promotion_closed`
rather than blaming the listener for an answer they were never shown a way to
give.

**"Reachable" there meant reachable from the fixture, not reachable from the
product.** Tracing every writer of `promotion_questions` and
`promotion_question_options` finds no door the product exposes that can leave a
non-`ESSAY` question with zero options. `save_promotion_question`
(`0055_promotion_freeze.sql:606-609`) refuses one before it is ever written —
*"a choice question needs at least two options, and % were given"* — and it is
the only function that inserts into either table, writing a question and its
options together in one call whether the question is new or being replaced.
`remove_promotion_question` deletes a question and its options together, never
options alone. Neither table takes an `insert`, `update` or `delete` grant from
any role, `service_role` included — `0044_rls_promotions.sql:36-37` grants
`select` only — so there is no direct-DML path around those two RPCs, and no
seed or script writes either table. Assertion 22's fixture reaches the state
with a privileged direct insert, which is not a door the widget's own screens,
or any script this project runs, expose. This project does hand-edit its
hosted database on occasion, which is the reason the hardening is worth
having; it is prophylactic rather than the explanation of what the owner
reported.

Whether it has ever actually happened in production is answerable, not merely
arguable. This settles it, run against the hosted database before the deploy:

```sql
select q.promotion_id, q.id, q.kind
  from public.promotion_questions q
 where q.kind <> 'ESSAY'
   and not exists (select 1 from public.promotion_question_options o
                    where o.question_id = q.id);
```

Zero rows converts "candidate (b) cannot be produced by the product" into
"candidate (b) never occurred" — an inference becomes a fact, and `0186` stays
prophylactic exactly as described above. A non-zero result names the promotion
it happened to and turns `0186` from a hardening measure into an urgent one:
some hand-written statement produced a state the product's own screens cannot,
and it is presently live.

The deploy obligation holds regardless of which candidate explains the
screenshot. `0186` exists locally and is applied to the local database only;
this project has shipped application code ahead of its migrations three times
already (Blocks 13a, 17b, 17c), and the two functions `0186` replaces are the
ones the live widget actually calls. If the app deploys without it, item 1's
fix reaches `pulchatx.com` and item 2's hardening does not — the hosted
behaviour is unchanged, and if the settling query above ever returns a row, a
listener can still be refused for a form the door never gave them a way to
complete.

**D4, either way.** `EnterPromotionPanel` holds every answer in its own state
and knows which screen each step sits on, so it can already compute the first
screen holding an unanswered step. On `missing_answers` it moves there, and the
sentence "Faltou alguma coisa. Volte e confira suas respostas." is shown at the
place it is talking about instead of asking the listener to search for it. This
is a courtesy and not a guard: the door stays the authority on what a promotion
asks, exactly as 0171's own comment insists, and a panel that finds nothing
unanswered leaves the listener where they are with the message unchanged —
which is precisely the state that means the screen and the door disagree, and
is worth being visible rather than smoothed over.

### 4.4 What proves it

A unit test over the "which screen is the first unanswered one" decision,
extracted into `src/lib/widget/promotion-mapping.ts` beside `answersFor` and
`decideAutoOpen` — the module that exists to be importable, since a `'use
server'` file cannot be. A panel-level branch that only a browser can reach
would be checked by nothing, which is the reason that module was split in the
first place.

A fix for (b) turned out to be needed, and it shipped with its own test,
written before it: assertion 23 in `42_widget_promotions.test.sql` was
rewritten to describe the repair before `0186` existed to make it pass.

---

## 5. What this block does not touch

- `identify-form.tsx`, and every refusal it renders. The screenshots are from
  after identification.
- The door functions in 0171 — except that the reproduction did prove the
  defect was inside one, exactly as this bullet's own escape clause allowed
  for. §4.3 found the reason, and migration `0186` is the result: it replaces
  both `widget_promotions` and `widget_enter_promotion`, and it must travel
  with the deploy — the failure this project has repeated three times.
- The navigation, and the catalogue screens. §6.

---

## 6. The two blocks after this one

Recorded here so they are not re-derived. Neither is designed yet; each gets
its own spec.

**Block 20b — navigation.** Owner's items 3, 4, 8 and 9: move Pedidos
(`/music/requests`) from the Música section to Audiência; rename the Música
section to Catálogo; move Relatórios and Administração above Modelos; and make
the sidebar a tree whose sections collapse. Everything except the last is
`src/lib/auth/shell.ts` plus `messages/*.json`; the tree is
`src/components/layout/sidebar-nav.tsx`, and carries open questions this spec
does not answer (what persists between visits, what is open on a first visit).

**Block 20c — the catalogue as three screens.** Owner's items 5, 6 and 7:
Gravadoras, Gêneros and Álbuns stop being `?tab=` on `/music/catalog` and
become three nav items of their own, each following the Músicas screen's shape
— a filtered list with a Cadastrar button opening a popup — and the album
record grows a thumbnail. `albums` already carries `cover_md5`,
`deezer_album_id`, `upc` and `release_date` (0136/0137), so the thumbnail has a
source for anything registered from Deezer; where the picture comes from for an
album typed in by hand is the open question that spec has to answer, and Block
14's promotion and prize images are the precedent to weigh. `/music/catalog`
itself disappears from the navigation, and what happens to the address is that
spec's to decide.

---

## 7. Verification

The gates this project already runs, in the order
`portoes-e-banco-local-sujo` records — `db:test` before the e2e and isolation
suites, never after, or two of them go red for reasons that are not the code.

`0186` does change the database, so a clean `db:test` is not purely a
regression check this time: assertions 20 through 23 in
`42_widget_promotions.test.sql` were rewritten to describe behaviour that did
not exist before this block, and their passing is a claim about new behaviour
rather than only the absence of a regression. The e2e widget spec still
matters as much as either: it drives both panels, and both are what this
block edits.
