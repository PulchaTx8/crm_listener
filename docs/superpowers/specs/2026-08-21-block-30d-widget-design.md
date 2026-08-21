# Block 30d — the question you can read, the number that is one number, and the entry that needs no walk

**Date:** 2026-08-21
**Base:** `main` at `2c701d6` — Block 30c (PR #92) merged, migrations `0258`–`0259`
confirmed applied to the hosted database.
**Depends on:** nothing. **Blocks:** nothing. 30e is independent of it.
**Parent request:** the owner's 19-item list of 2026-08-19, items **1, 2, 14**.

---

## 1. What this delivers

Four things a listener meets, none of which is an operator screen:

1. A promotion's quiz question is **shown** in the widget, above its alternatives.
2. A telephone number means the same thing whichever door it came through, and
   WhatsApp can always reach it.
3. The widget renders in **the Station's** language rather than in whatever
   language the last signed-in operator chose in that browser.
4. A promotion that asks nothing takes the entry **immediately** — by hashtag on
   WhatsApp, and straight after the code on the web.

## 2. What this deliberately does not deliver

- **The user's language gear.** It stays, and `profiles.locale` keeps painting
  the console. The owner's ruling of 2026-08-21: the Station's language governs
  what the *listener* reads, not what the *operator* reads.
- **Translation of the bot's own copy.** `DEFAULT_MUSIC_LINK_TEXT` and its two
  siblings (`engine.ts`), and `whatsapp_reply_body`'s four sentences (0062), are
  Portuguese constants. They are already per-Station overridable as free text on
  the same screen this block extends, and the four templates this block adds are
  registered at Meta with a language of their own. Making the constants
  multilingual is a separate errand with no item asking for it.
- **A Programme, a schedule view, or a map.** Block 30e, items 12, 18 and 19.
- **Merging the listeners the split already created.** See D5: the sanitation
  stops new splits and repairs the eight rows that carry the minority form.
  Fusing two listeners who are already two rows is the merge screen's job and the
  owner has not asked for a sweep.

---

## 3. The three items, mapped

| Item | Where | What changes |
| --- | --- | --- |
| 1a | widget, promotion panel | the question's text reaches the browser and is drawn above the alternatives |
| 1b | every door that writes a phone | one canonical form — international — through one shared function |
| 2 | `/messages/promo`, widget | the Station carries the listener's language; the widget stops asking the cookie |
| 14 | `ingest_link_intent`, widget promotion panel | nothing left to ask means the entry is taken now, not after a link or a walk |

---

## 4. Decisions

### D1 — The prompt travels **in the step**, not beside it

`whatsapp_conversation_steps` (0066) builds a question step as
`{kind, questionId, questionKind}`. `promotion_questions.prompt` — the text the
operator wrote, `not null` with a non-blank CHECK since 0041 — never leaves the
database. The widget draws the alternatives and nothing else, which is the
defect item 1 reports.

The step gains `prompt`. The alternative considered and rejected was a
`prompts` map keyed by question id, mirroring the `options` map
`widget_promotions` already builds (0173, 0186). Options are a map because they
are a *list per question* joined from another table; a prompt is one string,
one-to-one with the step, and putting it in the step is what lets the panel draw
`step.prompt` without a second lookup that can miss.

**Both callers get it and neither has to change**: `widget_promotions` passes the
function's answer straight through (`0186:57`) and `enter_promotion` recomputes
it (`0186:186`). `readSteps` (`promotion-mapping.ts`) drops any step whose shape
it does not recognise, so a step gaining a key is backward compatible by
construction — a browser holding an older bundle keeps working.

**A question with a blank prompt cannot exist** (0041's CHECK), so the panel has
no empty-prompt branch to write. It renders `step.prompt` unconditionally.

### D2 — The canonical telephone number is the **international** form

The owner's first instinct was a separate column holding the country's calling
code, concatenated at send time. This design stores the complete number in the
column that already exists, and it is the cheaper of the two on four measured
counts:

- **Existing rows.** Of 1 014 members in the hosted database, **1 005 already
  carry the international form** (13 digits opening `55`) and **8 carry the
  local form** — all eight of `first_contact_origin = 'WHATSAPP'`, which is the
  one path that converts. Storing local means slicing 1 005 rows into two
  columns; storing international means prefixing 8.
- **Identity.** `members.phone_normalized` is GENERATED from `phone` through
  `normalize_phone` (0031), and a partial unique index on it is what makes one
  person one row. A separate country column would force that index to become
  composite, because two listeners in two countries can share local digits — and
  with it `find_member_by_identifier` (0033), which 0031's own comment says must
  never disagree with the column. The international form is unique by
  construction and **no index and no generated column changes**.
- **Sending.** The Cloud API wants the international number. Stored whole, there
  is nothing to concatenate at any send site, and no site that can forget to.
- **Masking.** `member_phone_last4` (0254) and the reveal doors keep working
  unchanged, and the country code is present because it is part of the value —
  which is what the owner asked masked fields to show.

### D3 — Length is the discriminator, and it has to be

`international_phone(p_phone, p_country)` decides whether the digits it was
given already carry a country code. **It cannot decide that by looking at the
prefix.** Brazil has an area code 55 (Santa Maria, RS), so `5599998888` is a
local number that opens with its own country's calling code. `length` is what
separates them, and it is already the adopted rule: `whatsapp_local_phone`
(0062) strips `55` only at lengths 12 and 13, and this function is that rule
read in the other direction.

A calling code alone is not enough to decide, which the collision above proves:
`55` opens both a Brazilian country code and a Brazilian area code, and only
the **national length** tells them apart — 10 or 11 digits is a number that
needs a prefix, 12 or 13 is one that already has one. So the lookup is
`country_phone_rule(alpha2)` answering *(calling code, national min, national
max)*, and `international_phone` tests the international range **before** the
national one.

**It carries a row only for a country whose national numbering has been
verified** — BR, PT, ES, US and CA at the time of writing — and **returns the
digits unchanged for every other country**, and for a length no rule explains.
That is the same scope `whatsapp_local_phone` states for itself ("Strips +55
only; … other countries … are Block 9's reconciliation problem"), and it is the
safe direction: a number left alone is no worse than what is stored today, while
a wrong prefix creates exactly the duplicate this item exists to stop. Adding a
country is one row plus the pgTAP case that pins it.

### D4 — The sanitation runs **at the doors**, not inside the lookup

`apply_member_lookup` (0061) is the shared resolver nine migrations call, and
putting the sanitation inside it is the tempting single point. It is the wrong
one, twice over:

- It resolves; it does not write. A door that looked up the sanitised number and
  then **inserted the raw one** would find the right listener and still store the
  wrong form — the split, one layer deeper and harder to see.
- It has no country. It takes `p_org`; the calling code lives on `companies`.
  Adding a parameter to a Postgres function does not replace it, it **overloads**
  it — the old five-argument version keeps existing and every caller that was not
  edited keeps calling it, silently. Any such change must `drop` the old
  signature explicitly and restate every grant (the ACL loss of Block 24).

So `international_phone` is called by each door as the phone enters:
`widget_verify_code` (live on 0164), `create_member` / `update_member` (live on
0220), `resolve_or_create_member` (0054) and `import_participations` (live on
0056) — the manual entry and the spreadsheet, both reached from the
Participations screen — the API intake (0152), and `withdraw_marketing_by_phone`
(0231). One function, many call sites, which is what "one function" meant.

**The list is derived, not remembered.** `grep -rln "p_phone" supabase/migrations/`
is what produced it, and the plan re-runs that grep rather than trusting this
paragraph: a door added between this spec and its implementation would otherwise
be the one that keeps writing the raw value.

**The WhatsApp path loses a step.** `ingest_link_intent` (0179) and
`start_conversation` (0070) currently convert Meta's delivered `5511…` to the
local form before resolving the listener. They stop: the delivered value already
*is* canonical. `whatsapp_local_phone` stays defined — the conversation store is
keyed by the delivered form and 19a's Critical lives there — but nothing on the
member path calls it any more.

### D5 — The country goes on the Station, and the eight rows are repaired

Prefixing needs a country and **all six Stations carry `country = null`** today
(measured 2026-08-21). Two writes, both narrow:

- Every existing `companies` row gets `'BR'`, on the owner's confirmation of
  2026-08-21 that all six are Brazilian.
- The eight local-form members get their linked Station's calling code prefixed.

Both are data writes in a migration, and both are written to be **re-runnable and
self-limiting**: the member repair touches only rows whose current form the
function would change, so a second run is a no-op. `phone_normalized` is
generated, so the repair writes `phone` and the column follows.

**A Station created after this with no country cannot prefix.** The door stores
what it was given and logs it rather than refusing: refusing would stop a
listener registering because an administrator did not fill a select, and the
value it stores is exactly what it stores today.

### D6 — `listener_locale` is named for what it governs

The column is `companies.listener_locale`, not `companies.locale`. The console's
language stays on `profiles.locale` by the owner's ruling, and a column called
`locale` on the Station is an invitation for the next person to wire the console
to it — the mistake the name exists to prevent. Its comment says so.

It is edited on **`/messages/promo`**, the owner's choice of 2026-08-21, beside
the system texts and the two service hashtags: that screen is per Station, gated
on `templates.manage`, and is already the place where what the listener reads is
decided. The Station panel in the platform console was rejected because the
radio's own staff never opens `/admin/stations`.

Nullable, and null means today's behaviour. A Station that never chooses is not
broken by this block.

### D7 — The widget resolves its own language, and the cookie is why

Moving the setting does not fix the reported defect. `src/i18n/request.ts`
resolves every request from the `locale` cookie, and `src/middleware.ts:421`
writes that cookie from the signed-in profile with `path: '/'` — a path that
covers `/w`. An operator who set the console to English and then opens the
Station's own site sees an English widget, and would keep seeing one however the
Station's language is stored.

So the widget page reads `listener_locale` and wraps its own subtree in a
`NextIntlClientProvider` for that locale, overriding the root provider for
everything under it. Server-rendered strings use
`getTranslations({locale, namespace: 'widget'})`.

**It rides on `widget_frame_context` (live on 0164), and the choice is not
arbitrary.** The obvious carrier looks like `widget_station_identity` (0185),
which already answers the Station's name and logo — but `page.tsx:129` calls it
**only when the presentation is `app`**, so an embedded widget, which is the
whole point of the product, would never receive it. `widget_frame_context` is
the door `installationExists` calls on every widget request in both
presentations, which makes it the only one that always runs. It gains a key;
the middleware that reads `origins` from it for `frame-ancestors` is unaffected,
because nothing there enumerates the object.

**Known limit, accepted:** `<html lang>` is set by the root layout
(`src/app/layout.tsx:46`), which cannot know which installation is being served.
It will keep naming the cookie's locale. Recorded in §8 rather than fixed here,
because fixing it means a root layout that reads the route.

### D8 — "No quiz" is decided per **listener**, not per promotion

The owner's ruling of 2026-08-21. `whatsapp_conversation_steps` returns consent,
then *every stale or empty requested field for this listener*, then the
questions. A promotion with no quiz still asks a newcomer for a name and a CPF,
and asks a returning listener for nothing.

So the fast path triggers when the recomputed step list holds **no question and
no field** — which is the promotion's shape *and* this listener's history. A
newcomer fills the form once and every entry after that is immediate. The
alternative — entering regardless and leaving the declared fields empty — was
rejected: the promotion declared it wants those values, and a CPF the rules
require is not optional because the channel is convenient.

**The door recomputes; it never trusts the client.** That is 0171's rule and this
block does not weaken it.

### D9 — Four Utility templates, and one rule that covers both ways they can be missing

The owner's ruling: every reply on the WhatsApp fast path goes out as a template
of Meta's **Utility** category. `template_purpose` gains four values, one per
answer `apply_participation` can give — confirmed, already entered, too soon,
over limit — because the four sentences carry different variables and a single
template whose body is nearly all placeholder is what Meta rejects.

Two things can be missing at send time, and they get **one** rule:

> Send the template when a live registration exists for that purpose at that
> Station **and** every variable it needs is known. Otherwise send the same
> sentence as a session message.

The second half is not hypothetical. `whatsapp_reply_body` (0062) already has a
branch for a listener with no computable next chance and one for a promotion
with no ceiling — those sentences have no value to put in `{{2}}`, and a
template rendered short is refused by `enqueue_whatsapp_outbound` with 22023
(0111's own variable-count check).

The fallback is what keeps the six Stations that exist today working on the day
this ships, when none of them has registered anything. A session message is
legitimate here and only here: the listener sent the hashtag seconds earlier, so
the 24-hour window is open by their own act.

**Registration never depends on the reply.** The entry is written first; what can
vary is only which envelope carries the sentence.

### D10 — The web fast path records consent without a screen, and names the promotion

The owner's ruling: after the code is verified, a promotion with nothing left to
ask registers the listener and shows the final screen — no rules screen — and the
consent row is written anyway.

The objection was raised and the owner ruled; what this design does is make the
row **say what actually happened**. `member_consents.origin` (0032) is free text
and today the web door writes `'web-widget'` (`0234:157`). The fast path writes a
value of its own, so a row produced by the act of entering is distinguishable
from one produced by a click, for ever, by reading the row.

**And `promotion_id` gets filled — on both paths.** The column exists for exactly
this (`0032`'s comment: "recording which promotion's rules the Member agreed
to") and the `rules` insert leaves it null. The proof that this is an oversight
rather than a policy is **in the same function**: the marketing consent Block 29c
added a hundred lines below (`0234:254`, `0234:269`) does fill it. A `rules`
consent that does not name the promotion cannot defend anything, and that matters
more now that no one clicks.

---

## 5. Migrations

Nine, starting at `0260`. **The enum addition is alone in its file on purpose:**
Supabase runs each migration in its own transaction and a value added by
`alter type ... add value` cannot be *used* in the transaction that added it.

| # | File | What |
| --- | --- | --- |
| 0260 | `international_phone.sql` | `country_phone_rule(alpha2)` and `international_phone(phone, country)` |
| 0261 | `station_country_backfill.sql` | `'BR'` on every `companies` row with none (D5) |
| 0262 | `member_phone_international.sql` | the eight local-form members, re-runnable (D5) |
| 0263 | `phone_doors_international.sql` | the doors that write a phone call 0260 (D4) |
| 0264 | `question_prompt_step.sql` | `whatsapp_conversation_steps` carries `prompt` (D1) |
| 0265 | `listener_locale.sql` | the column, its door, and `widget_frame_context` returning it (D6, D7) |
| 0266 | `template_purpose_participation.sql` | four enum values — **and nothing else** |
| 0267 | `whatsapp_fast_entry.sql` | `ingest_link_intent` takes the entry when nothing is left to ask (D8, D9) |
| 0268 | `widget_fast_entry.sql` | `enter_promotion`'s fast path and the consent row (D8, D10) |

**Every redefinition copies the LIVE definition forward.** Every function this
block rewrites has been redefined since it was introduced, and **the first draft
of this spec cited two of them wrongly** — which is the trap demonstrating
itself:

| Function | Introduced | **Live** |
| --- | --- | --- |
| `widget_frame_context` | 0161 | **0164** |
| `widget_promotions` | 0171 | **0186** |
| `widget_enter_promotion` | 0171 | **0234** |
| `ingest_whatsapp_event` | 0062 | **0179** |
| `create_member` / `update_member` | 0034 | **0220** |
| `enqueue_whatsapp_outbound` | 0071 | **0224** |
| `import_participations` | 0054 | **0056** |
| `resolve_or_create_member` | 0054 | 0054 |
| `whatsapp_conversation_steps` | 0066 | 0066 |

Re-deriving a body from the migration that introduced it silently reverts every
repair made since, with nothing turning red. The table is a convenience; the
authority is the database:

```sql
select pg_get_functiondef('public.widget_enter_promotion'::regproc);
```

**`create or replace` cannot rename a `returns table` column** (42P13) and
**adding a parameter overloads rather than replaces** (D4). Either case needs
`drop` + `create` + every grant restated, and `select proacl from pg_proc where
proname = '…'` checked afterwards — this is how a function lost its ACL in
Block 24.

**None of these is edited in place after merge.** A repair is a new number.

---

## 6. Testing

- **pgTAP, starting at file 72.** `international_phone` over the shapes that
  matter: local with area code, already-international, the DDD-55 collision D3
  names, an unknown country, a length no country explains. The fast-path doors
  through a real caller, both the taken-immediately case and the
  something-still-to-ask case. The template rule with a registration present,
  absent, and present-but-a-variable-missing.
- **Unit.** `readSteps` keeping a step that carries `prompt`, and the pure
  function that decides a promotion needs no walk.
- **e2e.** The widget showing a question's text; the widget rendering in the
  Station's language **while a `locale` cookie says otherwise**, which is the
  defect and therefore the only honest form of that test.
- **Isolation.** The new doors, for the Station boundary every widget door
  carries (0164's suspension joins included).
- **Every test breaks the thing first.** The rule this project keeps relearning:
  a case that passes with and without the repair proves nothing. The 30c
  isolation case that did exactly that is the precedent.

---

## 7. What the owner has to do, and when

1. **Register four Utility templates per Station at Meta**, one per participation
   answer. Until then the fast path replies as session messages (D9) — working,
   not silent.
2. **Confirm the six Stations are `BR`** — assumed in 0261 on the ruling of
   2026-08-21.
3. Nothing else. `listener_locale` null means today's behaviour.

## 8. Debt this records

- **`<html lang>` still follows the cookie** in the widget (D7).
- **`whatsapp_local_phone` survives** with one caller left — the conversation
  store's key. It is Brazil-only by its own comment, and the day a second country
  runs a bot it will need the same treatment this block gave the member path.
- **The listeners the split already created are not merged** (§2). The eight rows
  repaired by 0262 are the ones that carry the minority form; a pair that is
  already two rows stays two rows.
- **The bot's Portuguese constants** are unchanged (§2).
