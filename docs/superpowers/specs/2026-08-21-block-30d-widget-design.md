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
| 14 | `ingest_whatsapp_event`, widget promotion panel | nothing left to ask means the entry is taken now, not after a link or a walk |

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
construction — a browser holding an older bundle keeps working. The other
direction is the one this project has actually hit before (Blocks 13a, 17b,
17c): a bundle built against this shape reaching a door that has not applied
0264 yet, whose step carries no `prompt` key at all — `readSteps` defaults it
to an empty string rather than dropping the step, so that deploy order does
not refuse the entry.

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

So `international_phone` is called by each door as the phone enters. **`0263`
wired seven functions**, and the list below is what it actually did rather than
what this paragraph first predicted:

| Door | Live on | What it sanitises |
| --- | --- | --- |
| `widget_request_code` | 0164 | the `widget_verifications` row **and** the number `enqueue_whatsapp_outbound` sends to |
| `widget_verify_code` | 0164 | the verification-row lookup, the member lookup, the registration |
| `create_member` | 0220 | the `members` insert |
| `update_member` | 0220 | the `members` update |
| `resolve_or_create_member` | 0054 | the lookup and, through `create_member`, the registration |
| `api_record_music_request` | 0152 | the validity guard, the lookup, the registration |
| `withdraw_marketing_by_phone` | 0231 | the lookup order only — it writes no telephone number |

**`widget_request_code` was not in this paragraph's first version, and the pair
cannot be split.** The original ruling was that both widget calls keep the
number the visitor typed, because the second call matches the verification row
the first one wrote. That was reversed on 2026-08-21: they *both* canonicalise,
computing the identical expression from the identical Station country, so the
row still matches — and asking in one spelling and entering in another, which
used to answer `no_pending_code`, now resolves to one number. Canonicalising
either one alone breaks code entry outright.

**`import_participations` (live on 0056) is NOT one of the seven**, though this
spec first listed it. Its only use of a row's phone is the argument it hands
`resolve_or_create_member`, which is in the list — so sanitising it too would be
the same rule written twice, one call apart.

One function, many call sites, which is what "one function" meant.

**And three doors gained a SECOND search rather than a replaced one.**
`resolve_or_create_member`, `widget_verify_code` and `api_record_music_request`
look for `international_phone`'s answer and then, if that finds nobody, for
`whatsapp_local_phone`'s — which is the shape `withdraw_marketing_by_phone`
already had. That is not caution: the WhatsApp doors below still register
listeners under the local form, so a canonical-only search would miss the
listener the bot already knows and register them a second time — the very split
item 1b exists to stop, arriving from the other direction.

The second search is **computed** — `whatsapp_local_phone` applied to the
canonical value — and never the caller's raw argument echoed back. The reason
differs by door, and an earlier draft of this paragraph wrongly gave one reason
for all three:

- At **`widget_verify_code`** and **`api_record_music_request`** a guard
  comparing the canonical value against the argument is simply *false*: their
  callers already post the international form (the widget's `composePhone`,
  `identify-form.tsx:41`; the API's documented contract, `docs/API.md:147`), so
  a raw second search would never run at all.
- At **`resolve_or_create_member`** it was true and the raw search did run —
  both its callers hand over keystrokes, the Participations manual form
  (`record-participation-form.tsx:264`, a bare input; `schemas/participations.ts:50`
  only trims) and `import_participations` feeding spreadsheet cells. What was
  wrong there was *what* it searched: an operator typing the international form
  made the raw search look for the number the canonical search had already
  looked for, so the bot's row was missed anyway.

Computing the bot's spelling answers both, and subsumes the raw search: when the
operator did type the local form, the computed value is exactly the digits they
typed. The branches say when they can be deleted.

**The list is derived, not remembered.** `grep -rln "p_phone" supabase/migrations/`
is what produced it, and the plan re-runs that grep rather than trusting this
paragraph: a door added between this spec and its implementation would otherwise
be the one that keeps writing the raw value.

**The WhatsApp path loses a step, and it is ONE function rather than the two
this paragraph first named.** Corrected in Task 8's fix round after being
checked against `pg_proc` instead of against the migration file list:

- **`ingest_link_intent` is not a function.** `0179_ingest_link_intent.sql` is a
  FILE name, and that migration defines exactly one function,
  `ingest_whatsapp_event`. Four comments 0263 wrote repeat the mistake and 0267
  corrects them where they sit.
- **`start_conversation` is not a function either.** The live one is
  `start_whatsapp_conversation` (0070), and it never converted a phone: it takes
  `p_phone` from its caller and passes it through. It was never part of this.

So **`ingest_whatsapp_event` was the ONLY door still writing the local form**,
and `0267` (Task 8) wires it to `international_phone`. **Item 1b closes with
that task**, not with 0263.

The delivered value is also not *already* canonical, though it is close enough
to look it: Meta delivers `5511988887777` and `international_phone` answers
`+5511988887777`, because the plus is part of the shape `members.phone` carries.
`phone_normalized` drops it again, so identity does not move — only the stored
spelling does.

`whatsapp_local_phone` stays defined, and 0267 keeps CALLING it: the door
searches the canonical form first and that function's answer second, which is
what still finds a listener the bot itself registered before 0267. The
conversation store is keyed on the delivered form (`v_from`) and 19a's Critical
lives there, but that key is `v_from` itself and has never involved this
function.

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
`normalize_phone`'s answer — **the digits, unprefixed and unpunctuated** — and
does not refuse: refusing would stop a listener registering because an
administrator did not fill a select, and guessing a calling code would split one
person into two rows. **Nothing is logged**, and nothing should be: this is the
function's answer, not a degradation of one, and a log line per registration at
a Station whose administrator has not filled in a select is noise that would
never be read. (An earlier draft of this section said the door "stores what it
was given and logs it". Neither half was true of the code: the digits are not
what it was given — the punctuation and any leading `+` typed by hand are gone —
and there is no log call anywhere on the path. `supabase/tests/72_international_phone.test.sql`
assertion 24 pins the real behaviour.)

**A leading `+` overrides all of this, at any Station.** `international_phone`
returns `'+'` followed by the argument's **digits** — punctuation and spacing are
still stripped by `normalize_phone`, so `+55 (11) 98888-7777` comes back as
`+5511988887777` — and it does so before consulting the country at all. What
survives is the plus, not the formatting; 0260's own comment states it the same
way. Without that, the length test decides using the
*Station's* national range and cannot tell a foreign number from a local one: at
a Brazilian Station (national 10–11) the eleven-digit `+12125551234` would be
read as national and rewritten to `+5512125551234`, and because `update_member`
calls this on every ficha save it would happen again every time an operator
tried to correct it.

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

**Where the branch sits, corrected in Task 8's fix round.** The task brief put
the fast path below both of `ingest_whatsapp_event`'s gates. The owner reversed
that on 2026-08-21, and the order is now **`no_rules`, then the fast path, then
`no_installation`**:

- **`no_rules` gates both ways of saying yes.** Rules are the consent the
  listener never clicks, and past that line there is no later door to catch a
  promotion nobody has written rules for. A promotion with no rules text still
  sends nothing.
- **`no_installation` guards only the LINK.** It exists because
  `widget_link_send_context` cannot mint one without an installation, and *the
  fast path mints none* — item 14 asks in as many words for the hashtag to
  register the listener "without sending a Widget link". Nothing the fast path
  calls reads `widget_installations` (checked against `pg_proc.prosrc`); the
  reply needs only the WhatsApp integration the door has already resolved.
  Gating it behind a widget would have killed it at every freshly provisioned
  Station, since **every** Station starts with no installation — creating one is
  a separate console act (0159), which `0179`'s own gate comment already says.

One observable consequence, recorded rather than discovered later: a Station
with **no installation and no rules text** now answers `no_rules` where it
answered `no_installation` before. Both are silent to the listener; the one
naming the promotion's own missing text is the more useful diagnostic, because
it is the half that Station can fix without a console act.

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
and before this block the web door wrote `'web-widget'` on every `rules` row it
made (`0234`, the insert immediately above `apply_participation`). The fast path
writes a value of its own — `'web-widget-entry'`, which `0268` is what creates —
so a row produced by the act of entering is distinguishable from one produced by
a click, for ever, by reading the row.

**And `promotion_id` gets filled — on both paths.** The column exists for exactly
this and the `rules` insert leaves it null. `0032`'s column comment, quoted from
the running database rather than from memory, reads in full:

> No foreign key yet: public.promotions does not exist. Expected to be set only
> when consent_type = 'rules'.

**This spec quoted a paraphrase of that sentence inside quotation marks** — as
"recording which promotion's rules the Member agreed to" — until Task 9 dumped
the column comment and found no such words in 0032. The real text is the stronger
of the two for this decision ("only when consent_type = 'rules'" names this row
and no other), which is exactly why the substitution was cheap to make and hard
to notice. Quotation marks are an invitation to trust a sentence without opening
the file, and this block has now been caught by that failure mode more than once;
a quoted sentence in this document is a sentence somebody read from the source.

**And half of that real comment is itself stale**: `member_consents_promotion_fk`
→ `promotions(id)` exists today (`\d public.member_consents`), so "No foreign key
yet" describes a schema that has moved on. What is still true is the second
sentence, which is the half this decision rests on. Filling the column therefore
lands against a live foreign key, on a promotion the door has already validated.

The proof that the null was an oversight rather than a policy is **in the same
function**: the marketing consent Block 29c added below it (`0234`) does fill it,
for a `consent_type` that comment did not have in mind at all. A `rules` consent
that does not name the promotion cannot defend anything, and that matters more
now that no one clicks.

### D10a — And the marketing consent is **not** written without a screen

The owner's ruling of 2026-08-21, fix round 1. The two halves of this decision
family look contradictory until the principle is stated, so it is stated here:
**the act carries the meaning, or there is nothing to record.**

- **Entering IS agreeing to the rules.** Choosing a promotion is choosing to take
  part in it under its published terms, and the rules text is the terms. So the
  `rules` row is written on the fast path, and the only thing it needs is an
  `origin` saying which act produced it.
- **Entering is NOT declining marketing.** Nothing about taking part in a
  promotion says anything about wanting messages from the Station afterwards. The
  fast path draws no consent screen, so the marketing checkbox is never shown and
  the panel posts its unticked default — and `widget_enter_promotion`'s arm B was
  turning that default into `granted = false`.

That row is not inert. `members_marketing_eligible_bulk` (0229) reads the latest
`whatsapp_marketing` row per (member, company), and Block 29d's campaigns pick
their audience through it — so a listener who took the fast path would have been
on file as having refused something nobody offered them, and this block would
have been what put them there.

So on the fast path the door writes **no `whatsapp_marketing` row at all** when
the listener has none, and leaves an existing row untouched. Absence is already
what this door's own existence check reads as "not asked yet", which is the truth
here; the listener stays askable on their next walk. **Arm A is not gated** — a
ticked box still writes `true` on any path, because a genuine opt-in must never be
dropped by a branch about screens.

Two consequences worth recording rather than rediscovering:

- The four cases pinning arms B and C in `42_widget_promotions.test.sql` were
  reaching that branch **on the fast path by accident**, because their promotion
  declared no requested fields. Their fixtures gained one (and two different
  ones, since two of their listeners enter both promotions); their assertions did
  not change. They were written to pin the marketing rule and they still do.
- The **two** consent-only promotions in `tests/e2e/widget.spec.ts`
  (`CONSENT_SWITCH_PROMOTION_A/B`) needed the same treatment for the same reason,
  one layer up: a consent-only promotion is now a promotion with no consent
  screen. **Three journeys** use them, which is the number this paragraph first
  reported as promotions.

### D10b — A link that names a no-walk promotion lands on **one screen with one button**

Fix round 3, and it exists because D10 as first built broke Block 19a's contract.

`?open=promotion&id=…` promises the widget opens **at the panel the link was
minted for** — the e2e case is titled "answers the open target it was minted
for". D10 turned the fast path's only entry point into the **list row's own
form**, and a link performs no tap on a list row. So `needsNoWalk` was true, the
panel deliberately drew no walk, and the listener landed on the generic promotion
list. The promise was broken precisely for the promotions this block set out to
make easiest to enter, and no task caught it because each was scoped to its own
e2e spec.

`decideAutoOpen` gains a **fourth outcome**, `confirm`, rather than the panel
growing a branch of its own. The decision turns on the same two inputs as the
other three — the listener's own promotion list, and the id — so answering it in
the effect would be the same question asked in two places, free to drift; and as
an outcome it is unit-testable, which a branch inside a `useEffect` is not.

**Not the list, and not an automatic entry.** The tempting shortcut was to enter
on render, since the promotion asks nothing. It is wrong: this door writes a
participation *and* a consent row, so a page that entered on render would enter
again on a refresh, on a link opened by mistake, and on whatever fetches a URL to
preview it. The list already costs one deliberate tap; the link costs the same
one, on a screen that names the promotion and shows its rules. One tap is not an
additional question, so item 14 still holds.

**Already-entered is still tested first**, and the order is load-bearing: a
no-walk promotion this listener has already entered stays `show-list`, the
ordinary render that shows them their own promotion with `alreadyEntered` on it.
Reversed, they would be handed a button whose only possible outcome is the
refusal `already_entered`.

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
| 0267 | `whatsapp_fast_entry.sql` | `ingest_whatsapp_event` takes the entry when nothing is left to ask (D8, D9) — and writes the canonical phone, closing D4 |
| 0268 | `widget_fast_entry.sql` | `enter_promotion`'s fast path and the consent row (D8, D10) — and, in fix round 1, the marketing row it must NOT write (D10a) |

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
- **`whatsapp_local_phone` survives**, and this note first described its callers
  wrongly. It has **four**, all of them the SECOND search a door makes after the
  canonical one misses: `resolve_or_create_member`, `widget_verify_code`,
  `api_record_music_request` and `withdraw_marketing_by_phone` (measured with
  `select proname from pg_proc where prosrc like '%whatsapp_local_phone%'`, which
  returns those four and `ingest_whatsapp_event`, whose own second search is the
  fifth). It is **not** the conversation store's key: that store is keyed on
  `v_from`, the phone exactly as Meta delivered it, and this function is not
  involved in it. Those searches reach the listeners the bot registered in the
  local form **before 0267**; what retires them is a sweep that leaves no
  local-form row behind, not a door that stopped writing new ones. It is
  Brazil-only by its own comment, and the day a second country runs a bot it will
  need the same treatment this block gave the member path.
- **The listeners the split already created are not merged** (§2). The eight rows
  repaired by 0262 are the ones that carry the minority form; a pair that is
  already two rows stays two rows.
- **The bot's Portuguese constants** are unchanged (§2).
