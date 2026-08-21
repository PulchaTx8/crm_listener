# Block 30c — two fields, one gate, and a menu that follows the errand

**Date:** 2026-08-20
**Base:** `main` at `77bda30` — Block 30b (PR #91) merged and in production.
**Depends on:** nothing. **Blocks:** 30e, whose item 18 filters participations by the
Programme this block attaches to a promotion.
**Parent request:** the owner's 19-item list of 2026-08-19, items **10, 11, 13, 15,
16, 17**.

---

## 1. What this delivers

Two new fields on a promotion — an authorization certificate number and an optional
Programme — a rule that makes the entry text mandatory once a door is open, two layout
corrections, a confirmation before discarding a half-written promotion, and the
PROMOTIONS menu in the order the errand actually runs.

## 2. What this deliberately does not deliver

- **Anything that uses the Programme link.** Filtering participations by its schedule
  is Block 30e's item 18. This block only records the association, which is what the
  owner's item 17 asks for in so many words: *"It will be used later for filtering and
  eligibility."*
- **A `shows.view` permission.** See D4 — the cost is recorded, not paid.
- **Any change to what the widget or the bot does.** Block 30d.

---

## 3. The six items

| Item | What changes |
| --- | --- |
| 10 | `Authorization Certificate Number`, optional, alphanumeric, to the right of `Site integration code` |
| 11 | PROMOTIONS submenu reordered, and Programmes moves into it |
| 13 | Registering a promotion asks before discarding typed data |
| 15 | Rules become mandatory once WhatsApp or website entry is on |
| 16 | `At most this many entries each` sits to the right of `At least this many hours apart` |
| 17 | An optional Programme on the promotion form |

---

## 4. Decisions

### D1 — The certificate is free text, and is not made unique

Owner's ruling. A `text` column, optional, no unique index — deliberately unlike
`site_integration_code`, which carries one (`0040`).

The reason to record it rather than leave it as an omission: that number is issued by
somebody outside this system, and this system has no way to know whether two promotions
sharing one is a mistake or a licence covering both. A unique index would turn a
question about paperwork into a save that fails with a message the operator cannot act
on.

### D2 — The rules gate refuses a **transition**, not a state

Once WhatsApp entry or website entry is on, `rules` must be non-blank. But `rules` was
added nullable and unconstrained (`0171`), and both doors have been enable-able without
it ever since — so promotions in production may already be in that state.

**The gate therefore refuses making things worse, not being in a state already reached.**
Formally, a write is refused when the resulting row has a door on and blank rules **and**
the existing row did not already. Which means:

| Operator does | Result |
| --- | --- |
| Creates a promotion with a door on and no rules | **Refused** |
| Turns a door on, rules blank | **Refused** |
| Clears the rules while a door is on | **Refused** |
| Edits the date of a promotion already door-on and rules-blank | **Allowed** |

The last row is the decision. An operator who needs to correct a prize or a closing date
on an old promotion is not held hostage to a text they may not have. A `CHECK` — even
`NOT VALID` — cannot express this, because it sees only the row being written and not the
row being replaced. The gate lives in `update_promotion`, which already reads the current
row.

**What this replaces is a silent absence, and that is the point.** A `web_enabled`
promotion with no rules is already invisible in the widget — `widget_promotions` (0186)
filters it out, and its own comment says a promotion that cannot be presented honestly
should be absent rather than broken on screen. Today the operator gets no signal at all.
After this, they get one at the moment they cause it.

### D3 — The Programme link survives the Programme being archived

`shows` is soft-deleted through `deleted_at` (`0098`). A promotion pointing at an
archived Programme keeps pointing at it, and the promotion record renders the name with
an **archived** marker beside it.

This is the treatment `list_music_requests` already gives an archived song — `0101` is
deliberately never refused over a live request naming it, because *"a request is a
historical fact that outlives the song"*, and `songArchived` exists so the screen can say
so rather than imply the song is still in the catalogue. A promotion that ran inside a
Programme ran inside it whether or not the Programme is still on air.

It also keeps Block 30e possible: item 18 reads the Programme's schedule to bound a
participation window, and a link cleared on archive would silently disable that filter
for exactly the historical promotions somebody is most likely to be auditing.

The combobox lists only **live** Programmes of the promotion's own Station.

### D3a — Correction, found during Task 3: the display half of D3 is unreachable

D3 as written above says the record renders an archived Programme's name with an
**archived** marker. **It cannot, and shipping a branch for it would be dead code
that reads as a working feature.** Two independent reasons, both verified:

- **Nothing archives a Programme.** `grep` over every migration finds no statement
  setting `shows.deleted_at`. There is no door, no RPC and no screen that does it.
- **Even if one existed, the row would be invisible.** `shows_select_music_view`
  (`0099:55-57`) is `deleted_at is null and has_permission('music.view', company_id)`
  — **no owner exception**. Contrast `promotions`' own policy (`0044:47`),
  `deleted_at is null or is_owner_of_company(company_id)`, which 0044 comments on as
  a deliberate difference. So an archived Programme is unreadable by everyone,
  the embed returns null, and the screen would show **no Programme at all** — not a
  marked one.

**What D3 still delivers, and it is the half that matters:** the *link* survives.
`show_id` has no referential action and nothing clears it, so the column keeps
pointing at the archived Programme and Block 30e can still read its schedule
through a privileged path. That was the load-bearing half.

**What changes:** Task 4 does **not** render an archived option, and
`PromotionDetail.showArchived` stays in the shape as the honest answer to "is the
linked Programme still live", derived from the embed rather than guessed. Today it
is always false because the state it names cannot occur.

**Debt:** making the display half real needs two things this block does not do — a
way to archive a Programme at all, and an owner exception on `shows`' select policy
so an archived one can still be read. Both belong to whoever owns the Programmes
screen, not to a promotion field.

### D4 — Programmes moves to PROMOTIONS, and the permission does not move with it

Owner's ruling of 2026-08-19. The submenu becomes: **Promotions, Participations,
Pickups, Programmes.**

**The cost, recorded rather than discovered.** `shows` carries exactly one policy, gated
on `music.view`. Block 18 filed the screen under Audience and wrote that mismatch down;
Block 27 moved it to Catalog and *removed* the mismatch, because `music.view` is that
section's own permission. This move reintroduces it: a member who administers promotions
and holds nothing in music will see the link and find nothing behind it.

Not fixed here, and the reason is the fix's shape rather than its size. A `shows.view` /
`shows.manage` pair is a permissions migration, the Roles screen, every seeded role,
`docs/PERMISSIONS.md` — and above all **every role a customer has already configured**,
none of which would grant it. Shipping the screen behind a permission nobody holds hides
it from everyone. Re-gating on `promotions.view` instead is one migration, but it takes
the screen away from whoever administers the catalogue and has it today.

Both are product decisions with blast radius, and neither is item 11.

**The mismatch has a SECOND surface, found in Task 4's review and not anticipated
here.** `listShowOptions` reads through the caller's own client, so
`shows_select_music_view`'s `music.view` gate applies to it too: a member holding
`promotions.edit` but no `music.view` sees the Programme combobox of item 17 with
**no options at all** — permanently reading "No programme", for every promotion.

That is worse than the menu case and worth stating separately. A link that leads
nowhere is visibly broken; a combobox that is simply empty looks like a Station
with no Programmes, and the operator has no way to tell the two apart. Same root
cause, same deferred fix, but whoever decides the `shows.view` question should
weigh this surface rather than only the nav link.

### D5 — Two layout corrections, and one of them exposes a spacer that was waiting

Item 10's field goes where `promotion-fields.tsx` currently renders
`<div className="hidden sm:block" aria-hidden="true" />` — a spacer that exists to keep
the two-column grid aligned after `Site integration code`. The certificate takes that
cell, and the spacer goes.

Item 16's two fields both live inside `{repeats && …}` blocks in the bordered repeats
box (`promotion-fields.tsx:126-196`), which is a **`flex flex-col`** — so two `w-64`
labels stack by construction, however short they are. They are wrapped in a row, so the
ceiling reads beside the interval it qualifies: *at least this far apart, at most this
many* is one sentence.

**Item 16 also makes an existing comment true.** The block introducing the ceiling
(`:161-162`) already describes it as *"the per-person ceiling (design spec D1), beside
the interval it depends on"* — beside is what it has never been, because the container
stacks. The layout was the thing that drifted from the comment, not the other way round;
this is the same false-comment class that dominated Blocks 30a and 30b, arriving from the
other direction.

### D6 — Registering asks before discarding, using the machinery already there

`PromotionRecordDialog` already tracks `dirty` and asks `window.confirm` before closing
(`:278`). `RegisterPromotionForm` passes `onDirty={() => undefined}` to both field groups
— the hooks exist and are wired to nothing.

Item 13 is connecting them: the same state, the same confirm, the same string. Both the
Cancel button and the dialog's own dismissal go through it.

---

## 5. Migrations

Two, and the second one is the dangerous one.

| # | File | What |
| --- | --- | --- |
| 0258 | `promotion_certificate_and_show.sql` | `authorization_certificate text`, `show_id uuid` with its composite FK, both with `comment on column` |
| 0259 | `promotion_rules_gate.sql` | `create_promotion` and `update_promotion`: the two new parameters, and D2's gate |

**`create_promotion` and `update_promotion` have been redefined SIX times** — `0042`,
`0050`, `0055`, `0144`, `0172`, `0184`. That is the deepest stack of redefinitions in this
schema, and it makes the standing rule non-negotiable here: the new bodies are
`pg_get_functiondef` of the **live** functions with the change applied, never `0184`'s
text retyped and never any earlier one. Re-deriving from `0172` would silently revert
`0184`'s hashtag collision guard; from `0144`, five rounds of repair at once. Nothing
would turn red.

**The FK is composite**, `(show_id, company_id) references shows (id, company_id)` — the
device this schema uses everywhere to make a cross-Station reference unrepresentable
rather than merely unlikely. `promotion_questions` (`0041`) and `promotions` itself both
carry one.

`show_id` is **not** `on delete cascade` and not `on delete set null`: `shows` is
soft-deleted, so nothing is ever deleted for a rule to fire on. D3 is the behaviour, and
it needs no referential action to hold.

---

## 6. Files

Final review fix wave: this section undercounted the branch at first pass, naming
ten files where `git diff main` (against the base named at the top of this document)
names well over three times that — the ten below, plus every other file this block or
its final review actually touched: two more pgTAP files the rules gate reaches into
for its own reasons, three e2e journeys correcting a stale argument count, the
isolation harness and two of its suites, and the unit suite this same wave finally
populated. What follows IS that `git diff`, not a hand-kept list — the next reader who
wants the authoritative one should re-run it rather than trust this section to have
stayed current either.

**New**
- `supabase/migrations/0258_promotion_certificate_and_show.sql`
- `supabase/migrations/0259_promotion_rules_gate.sql`
- `supabase/tests/71_promotion_rules_gate.test.sql`
- `tests/e2e/promotion-rules-gate.spec.ts`
- `tests/unit/promotion-show-options.test.ts` — final review fix wave, Critical #1

**Changed**
- `src/services/promotions.ts` — the two fields, and a `showArchived` flag
- `src/services/shows.ts` — `listShowOptions` (item 17's combobox)
- `src/schemas/promotions.ts` — validation for both
- `src/app/(app)/promotions/promotion-fields.tsx` — items 10 and 17, plus the
  final review's `resolveShowOptions` (Critical #1)
- `src/app/(app)/promotions/whatsapp-fields.tsx` — the rules field's required
  state, removed again by the final review (Important #1)
- `src/app/(app)/promotions/register-promotion-form.tsx` — item 13
- `src/app/(app)/promotions/actions.ts` — carrying the two fields
- `src/app/(app)/promotions/page.tsx`, `promotions-grid.tsx`,
  `promotion-record-dialog.tsx` — the combobox's data, and item 11's reorder
- `src/app/(app)/shows/page.tsx` — Programmes joining the Promotions menu
- `src/hooks/use-record-dialog.ts`
- `src/lib/auth/shell.ts` — item 11
- `src/lib/supabase/database.types.ts` — regenerated
- `messages/{en,pt,es}.json`
- `scripts/verify-isolation-suite.mjs`
- `supabase/tests/02_permissions.test.sql`, `03_promotions.test.sql`,
  `47_promotion_hashtag_collision.test.sql` — the nineteen-argument signature
- `tests/e2e/deadline.spec.ts`, `draw-flow.spec.ts`, `send-lists.spec.ts` —
  the same signature, in present-tense comments
- `tests/isolation/harness.ts`, `participations.test.ts`, `promotions.test.ts`
- `tests/unit/promotions-schema.test.ts` — the final review's §7 unit tests
- `docs/DATABASE.md`, `docs/PERMISSIONS.md`

**Not changed, despite an earlier version of this list saying otherwise:**
`src/app/(app)/promotions/record.ts`.

---

## 7. Testing

- **pgTAP** — D2's four rows, each as its own assertion, including the one that must be
  **allowed**; and that the composite FK refuses a Programme from another Station.
- **Isolation** — the gate through a real caller, since `update_promotion` is
  SECURITY DEFINER and the pgTAP runs as superuser.
- **Unit** — the schema's validation of the certificate and of `showId`.
- **Playwright** — one journey: register a promotion, type into it, dismiss, get the
  confirmation; then turn on website entry with the rules empty and be refused with a
  message naming the rules.

**Gate order** `db:reset` → `db:test` → `test:isolation`, then `seed:branding` and
`test:e2e`. Run the e2e suite **whole and once** — `playwright.config.ts` pins one worker
locally because `next dev` compiles each route on first visit, and sharding multiplies
that cost by restarting the server per shard.

---

## 8. Debt this records

- **The `shows` permission mismatch returns** (D4), and it is now the second time this
  screen has moved. Whoever decides the `shows.view` question should know it has been
  filed under three different sections in twelve blocks.
- **The certificate is not validated against anything.** It is a string this system
  stores and shows. If it ever needs a format, that is a rule somebody outside this
  system owns.
- **The gate cannot repair what already exists.** Promotions currently door-on and
  rules-blank stay that way until somebody edits them into compliance, and stay invisible
  in the widget meanwhile. A report listing them is a reasonable follow-up and is not
  this block.
