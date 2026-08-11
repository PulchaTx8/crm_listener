# Block 17c — A listener on the Station's own site enters a promotion

**Date:** 2026-08-11
**Status:** awaiting review
**Block:** 17c (the last of three; 17a and 17b are merged and live)

---

## 1. What this is for

17b enabled the widget's first button. This enables the second: a listener who
identified themselves through 17a sees the Station's live promotions, reads the
rules, agrees to them, answers whatever the promotion asks, and the entry lands
in `participations` with source `WEB` — the same table the operator's screen, the
draw and every report already read.

---

## 2. The inheritance, checked this time

17a's design says 17c gets `whatsapp_conversation_steps` (0066) for free. The
equivalent sentence about 17b was **wrong**, so this one was read before it was
believed. It holds:

```
whatsapp_conversation_steps(p_promotion_id uuid, p_member_id uuid) returns jsonb
  language sql, stable, SECURITY INVOKER, execute granted to nobody
```

It returns `consent`, then every requested field that is empty or stale, then
every question in position order — and it knows nothing about WhatsApp beyond its
name. Its own comment says it is "called only from inside a SECURITY DEFINER
body", which is exactly how this block will call it.

`apply_participation` also holds, with a caveat that cost time to find: **it has
two definitions, 0054 and 0069, and the live one is 0069.** It takes
`p_source public.participation_source`, so this block needs a new enum value and
no new write path.

What is **not** inherited: `participation_source` has `MANUAL, IMPORT, WHATSAPP`
and no `WEB`.

---

## 3. Decisions

The owner's, taken 2026-08-11.

**D1 — A promotion says which doors it takes part through, and there are now
two boxes.** ~~Every live promotion appears; no flag column.~~ **Revised
2026-08-11, during implementation**, and the reason is a constraint nobody had
read:

```
promotions_whatsapp_shape:
  (whatsapp_enabled and hashtag is not null)
  or (not whatsapp_enabled and hashtag is null and use_art = false
      and art_url is null and yes_button_label is null
      and no_button_label is null and cardinality(requested_fields) = 0)
```

**A promotion with `whatsapp_enabled = false` cannot have requested fields or
art at all** — the database forbids it. That constraint encodes an assumption
that was true while there was one door: these things exist *because* there is a
WhatsApp conversation. 17c makes it false, because it asks the same fields
through a different door.

So `promotions` gains **`web_enabled boolean not null default false`**, the
sister of `whatsapp_enabled`, and the operator ticks **"Participar pelo
WhatsApp"**, **"Participar pela Web"**, or both. Either box allows art,
requested fields and questions; neither leaves the promotion unable to converse
anywhere. `hashtag` and the two button labels stay tied to `whatsapp_enabled`
alone — they are objects of that conversation and of nothing else.

**A promotion appears in the widget when `web_enabled` is true AND it has
rules.** Two conditions, deliberately: the box says where it belongs, the rules
are the content that door requires. **Ticking the box does NOT make rules
mandatory** — the owner rejected a mandatory rules field on the form, so an
operator can save a promotion marked for web while they write the wording, and
the screen tells them it is not visible yet.

**D2 — Promotions gain a rules text, and the widget shows it with the art.**
`promotions` carries `name`, `art_url` and `thumb_url` and **no rules of any
kind** — so a consent step on a website would have asked somebody to agree to
something that appears nowhere. A new long-text column, shown in the widget above
the agreement box, together with the art the Station already uploads.

**D3 — A promotion with no rules does not appear in the widget.** The column is
new, so on the day this ships **every existing promotion is invisible in the
widget** until somebody writes its rules. That is the intended behaviour and not
a migration gap: an empty agreement box is precisely what D2 exists to prevent.

**D4 — Nothing partial is ever written.** The walk is browser state; one door
writes fields, confirmations, answers and the entry in a single transaction.
Abandoning halfway writes nothing and there is nothing to resume.

**D5 — The web door records the `rules` consent; WhatsApp will follow.** See §5.

**D6 — The walk is not a chat.** See §6.

---

## 4. Why nothing partial is written

The obvious alternative is to mirror the WhatsApp conversation: persist progress
per step and let a listener resume. It was rejected for two reasons, and the
second is the one that decides it.

**A web form is three to six screens, not a conversation over hours.** The
resume window exists on WhatsApp because a listener answers a message when they
happen to look at their phone. Nobody abandons a form and returns to it two days
later expecting their half-typed address to still be there.

**The first step is consent.** Writing a listener's address, birth date and CPF
to `members` as they type them — before they have agreed to anything — collects
personal data ahead of the agreement that authorises collecting it. `LGPD`
inverts that order, and a design that persists progress step by step gets it
backwards by construction. One transaction at the end makes the wrong order
impossible rather than merely avoided.

---

## 5. What the door writes, and the one divergence

`complete_conversation` (0071) is the reference implementation, and this block
does what it does:

1. **The field values onto `members`**, through the same eight-way mapping —
   `coalesce` per field, so an unanswered field is left alone rather than
   blanked.

   **This block does NOT write a third copy of that mapping.** 0065's
   `member_field_value` reads it and 0071's `complete_conversation` writes it,
   and both comments name the other precisely because a ninth requested field is
   an edit in every copy. 0171 extracts the write half into
   `apply_member_field_values(p_member_id, p_fields jsonb)` and calls it.

   **0071 is deliberately left alone today.** Rewriting its body to call the new
   helper means retyping a shipped function, which is how 0168 silently reverted
   0163's public-key pin one block ago. The convergence is a follow-up with its
   own tests, not a side effect of this block.
2. **One `member_field_confirmations` row per field the listener actually
   answered**, stamped `now()` — the confirmation records when we were told.
3. **`apply_participation(promotion, member, now(), 'WEB', answers)`** — the same
   core the operator's door and the import use.

**The divergence, stated rather than slipped in:** `complete_conversation` writes
**no consent row at all**. Agreement on WhatsApp leaves no `member_consents`
trace; only a refusal is recorded, as `promotion_refusals`.

This block **does** write one, of type `rules` — the value 0032 defines as
"agreement to a promotion's rules" — with the promotion in the detail. There is
now a rules text that was displayed and agreed to, and the difference between
"they clicked" and "here is what they accepted and when" is worth one row.

**The owner has ruled that WhatsApp will record the same consent when that door
is next worked on.** Until then the two doors differ, deliberately and in
writing.

---

## 6. The screen

Three states: **list → walk → done**.

The list shows each live promotion's name, the thumbnail of its art, and whether
this listener has already entered.

**The walk is not a chat**, and that is a deliberate departure from the shape the
step list implies. The bot asks one thing per message because a conversation has
no other shape; a page does.

| screen | what is on it |
| --- | --- |
| 1 | the art, the rules in a scrollable area, and the agreement box |
| 2 | **every** requested field at once |
| 3+ | one question per screen, because each carries its own options |

Consent stays alone because it gates everything after it. The fields collapse
onto one screen because that is what a person filling in a form on a website
expects, and it still answers exactly what the step list asked for.

**Refusing is a real path.** A listener who does not agree gets a
`promotion_refusals` row — the same table the WhatsApp flow writes — and the
screen says the entry was not recorded.

---

## 7. The doors

Both `security definer`, granted to `service_role` alone, revoked from `public` —
the shape 0161 established and 0167 followed.

### `widget_promotions(p_public_key, p_member_id) returns jsonb`

The list. Applies the three refusals every widget door shares —
`unknown_installation`, `unknown_listener`, `listener_anonymized` — and returns
each live promotion with rules, its art, and whether this listener has a valid
entry already.

### `widget_enter_promotion(p_public_key, p_member_id, p_promotion_id, p_consent, p_fields, p_answers) returns jsonb`

The write. After the three shared refusals:

1. **The promotion belongs to this Station and is open.** Derived from the key,
   never from the caller.
2. **`whatsapp_conversation_steps` is recomputed HERE**, server-side, and what
   arrived is checked against it. **The screen is not the authority on what to
   ask.** A payload missing a field the promotion requires is refused with
   `missing_answers` rather than written half-complete.
3. **Refusal** (`p_consent` false) writes `promotion_refusals` and stops.
4. Otherwise: the three writes of §5, plus the `rules` consent row.

`created_by` is null throughout, and `actor_id` on the audit row is null: 0129
says a null there does not mean "the system did it", and a website visitor is not
an `auth.users` row.

---

## 8. Migrations

**`0170_widget_participation_source.sql`** — `alter type
public.participation_source add value 'WEB'`, alone, because `ALTER TYPE … ADD
VALUE` cannot share a transaction with a statement that uses the value.

**`0171_widget_promotions.sql`** — `promotions.rules text` (nullable: production
already holds promotions, and D3 makes the empty case meaningful rather than
broken), **`promotions.web_enabled boolean not null default false`**, the
replacement of `promotions_whatsapp_shape` (D1), the shared listener context,
the field writer, the two doors, comments and grants.

**The constraint is replaced, not edited in place.** The new shape:

```sql
-- The conversational parts belong to EITHER door now.
check (
  (whatsapp_enabled or web_enabled)
  or (use_art = false and art_url is null and cardinality(requested_fields) = 0)
)
-- These belong to WhatsApp alone, and still do.
check (
  (whatsapp_enabled and hashtag is not null)
  or (not whatsapp_enabled and hashtag is null
      and yes_button_label is null and no_button_label is null)
)
```

Splitting one constraint into two is deliberate: a single condition covering
both doors and the WhatsApp-only fields would fail as one anonymous violation,
and an operator who forgot a hashtag would be told the same thing as one who set
art on a promotion that converses nowhere.

**Every existing row satisfies both** — `web_enabled` defaults to false, so the
first branch reduces to the old one. No backfill.

---

## 9. How it is proved

| suite | what it pins |
| --- | --- |
| pgTAP | a promotion with no rules is absent from the list (D3); a closed one is refused; a second entry refused when `allow_multiple_entries` is false; **a payload answering the wrong fields refused with `missing_answers`**; `source = 'WEB'`; the `rules` consent row; a refusal writing `promotion_refusals` and no participation |
| unit | the Zod shapes; the refusal mapping |
| isolation | `promotions.rules` readable by whoever already read promotions; both doors granted to `service_role` only |
| e2e | identify → list → agree → fields → question → the entry in `participations` with `source = 'WEB'`, read from the database rather than off the screen |

**The assertion that matters most is the server recomputing the steps.** Without
it, the screen quietly becomes the authority on what a promotion asks, and the
first promotion edited while somebody has the widget open writes an entry that
answers the wrong questions.

---

## 10. Application files

| file | change |
| --- | --- |
| `src/app/(widget)/w/[publicKey]/promotion-actions.ts` | new — list, enter |
| `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` | new — the three states |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | the second button enables |
| `src/schemas/widget-promotions.ts` | new |
| the promotions form (operator) | the rules field |
| `src/services/promotions.ts` | `rules` through the read and the write |
| `messages/{en,pt,es}.json` | every string, three languages |

---

## 11. What was considered and removed

- **An "accepts web" flag on promotions** — D1. A promotion configured once
  should work at both doors.
- **Persisting the walk step by step** — §4.
- **A rules URL instead of text** — a document that moves or goes offline leaves
  no record of what was agreed to. The text lives in the database for the same
  reason the consent row does.
- **Making rules mandatory on the promotions form** — it would stop an operator
  saving a half-finished promotion while they think about the wording. D3 makes
  the promotion invisible in the widget instead, which costs nothing to anybody
  not using the widget.

---

## 12. Risks, stated rather than discovered

**On the day this ships, the widget's promotion list is empty at every Station.**
D1 and D3 working as designed — `web_enabled` defaults to false and no promotion
has rules — and it will look like a bug to anybody who has not read this. The
promotions screen should say, per promotion, which of the two conditions is
still missing.

**`promotions_whatsapp_shape` is replaced by two constraints (D1, §8).** Any
screen or service that today validates "art and fields require WhatsApp" is now
wrong and must be found: `grep -rn "whatsapp_enabled" src`. This is the part of
the block most likely to leave a stale rule behind, because the old rule lives
in TypeScript as well as in the database.

**The eight-way field mapping still has two writers until 0071 adopts the
helper.** This block extracts `apply_member_field_values` and uses it rather than
writing a third copy (§5), but `complete_conversation` keeps its own inline
version until a follow-up converges them with tests of its own. Until then a
ninth requested field is an edit in three places, and 0171's comment must say so
where somebody adding one will look.

**The two doors disagree about consent until WhatsApp is revisited** — §5,
by the owner's decision.
