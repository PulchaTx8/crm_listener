# Block 3 — Members — Design

**Date:** 2026-07-28
**Depends on:** Block 1c (roles per Company) and Block 2 (the permission catalogue's
`module`/`scope` shape). Nothing here depends on the inventory ledger.

---

## 1. What this block is, and what it deliberately is not

The Member is the audience — the person who enters a promotion and receives a prize.
This block builds who they are, how the system avoids registering the same person
twice, who inside the Organization may see them, and what happens when they misbehave
or ask to be forgotten.

It is **not** the promotion, the participation or the delivery. And, by the owner's
decision, it **does not store a photographed document**: no private bucket, no
download proxy, no per-view access log, no document retention. Those exist in the
master spec (N2) and they arrive in **Block 6**, where a document is actually asked
for — at the moment someone collects a prize. Building the vault before there is
anything to put in it would be a large, sensitive mechanism guarding nothing.

What this block does carry is the harder half of the same problem: **personal data
that must be findable, shareable across a group of Stations, and erasable on request,
while an immutable audit trail sits underneath it.**

## 2. Decisions taken

Fixed by the product owner on 2026-07-28:

1. **No document images.** The CPF is stored as a **normalised hash** for
   deduplication plus the **last digits** for a human to confirm against. The raw
   number is never stored, so it cannot leak from a dump or a query log.
2. **Three consents:** the promotion's rules, the use of the Member's image and name,
   and communication from a sponsor — each recorded separately, with date and origin.
3. **No WhatsApp consent record.** The owner's position: a Member who messages the
   Station first has authorised the reply. This block therefore records the
   **origin and the date of first contact**, which is the evidence that position
   rests on, and keeps the consent mechanism open so Block 5 can add a type without a
   migration. *This is a legal judgement the owner made and it is recorded here as
   theirs, not derived.*
4. **Four things can happen to a problem Member:** barred from draws, suspended until
   a date, archived, or erased.
5. **The registration carries** name, phone, e-mail, CPF, date of birth, full address
   and how they found the Station.

## 3. The Member belongs to the Organization; access belongs to the Station

This is the model the master spec fixes in §4.5, and it is the reason this block is
harder than a CRUD screen.

A person is **one Member across the Organization** — the same listener who enters a
promotion on Rádio A and another on Rádio B is one record, deduplicated once. But
**visibility is per Station**: a user sees a Member only if that Member has a link to
a Station the user can reach.

Two consequences the design has to honour:

- The detail screen's "Stations they took part in" lists **only the Stations the
  viewer can reach**. A user restricted to one Station must not learn, from a Member's
  own page, that this person also enters promotions at a sibling Station.
- Deduplication is **Organization-scoped**, so it must consult records the caller
  cannot see. That is the whole difficulty, and §4 is the answer.

## 4. Deduplication without leaking

When someone registers a Member with a phone number that already exists in the
Organization but only at a Station the registrant cannot reach, the system must not
create a duplicate — and must not reveal the existing person either.

A `SECURITY DEFINER` function resolves it at Organization scope and returns
**only what the caller is entitled to know**:

- **No match** → "no match".
- **A match the caller can already see** → the `member_id`, so the screen offers to
  open the existing record.
- **A match the caller cannot see** → "this person is already registered in this
  Organization, at a Station you do not have access to. Ask someone who does, or ask
  the owner to give you access." The id is **not** returned, no name, no phone, no
  Station name.

The third case is the one that matters, and it is a deliberate, uncomfortable trade:
the registrant learns that *someone* holds that phone number. That is unavoidable —
any system that prevents duplicates across a boundary leaks the existence of what is
on the other side. What it must never leak is **who**. The message says what to do
next, so the answer is a workflow rather than a dead end.

Underneath, **partial unique indexes** per Organization on normalised phone,
normalised e-mail, CPF hash and passport, each `where deleted_at is null` (spec N5),
so archival and re-registration do not collide with a logically deleted row. The
function is the friendly path; the indexes are what make a duplicate unrepresentable
even if a future RPC forgets to call it.

**Merging two Members** that turn out to be the same person requires an elevated
permission and is audited. It is **out of scope here** — it needs participations and
deliveries to re-point, which do not exist yet, and doing it now would mean inventing
their contracts blind. Block 9's ETL is the first caller that genuinely needs it.

## 5. Data model

**`members`** — Organization-scoped.

```
id, organization_id,
full_name, phone, phone_normalized, email, email_normalized,
cpf_hash, cpf_last_digits, passport,
birth_date,
address_line, address_number, address_complement,
neighbourhood, city, state, postal_code,
discovery_source,
first_contact_at, first_contact_origin,
anonymized_at,
created_by, created_at, updated_at, deleted_at
```

- `phone_normalized` and `email_normalized` are generated, not hand-maintained: a
  normalisation that is applied by whoever remembers is a normalisation that drifts.
- `cpf_hash` is a normalised SHA-256; **the raw CPF is never stored**. `cpf_last_digits`
  is what a person confirms against out loud. A dump yields no CPF.
- `first_contact_at` / `first_contact_origin` carry the evidence behind decision 3.
- Partial unique indexes per `(organization_id, …)` on `phone_normalized`,
  `email_normalized`, `cpf_hash` and `passport`, each `where deleted_at is null and
  <column> is not null` — a Member with no e-mail must not collide with another that
  also has none.

**`member_company_links`** — which Stations a Member has taken part in.
`(member_id, company_id, organization_id)` with the composite foreign keys Block 1c
established, so a link cannot join a Member of one Organization to a Station of
another. This table is what RLS reads.

**`member_consents`** — `member_id`, `consent_type`, `granted`, `granted_at`,
`origin`, `company_id`, `promotion_id` (nullable, for the rules consent), `recorded_by`.
Append-only: a withdrawal is a **new row**, not an edit. "Did they consent on the day
they entered" is a question the table must be able to answer years later, and a
mutable row cannot.

**`member_notes`** — free text an operator adds. Per Station, not per Organization: a
note written at one Station is not automatically visible at another.

**`member_blocks`** — `member_id`, `company_id` (nullable: null means the whole
Organization), `kind`, `reason`, `starts_at`, `ends_at` (nullable = indefinite),
`created_by`. Append-only, like consents.

## 6. A suspension ends because the date passed, not because a job ran

The owner fixed this principle in Block 2 for the uncollected prize, and it applies
here unchanged: **a block with an end date expires because `ends_at` is in the past**,
derived at read time. No cron marks it expired, so no cron can fail to.

`is_member_blocked(member_id, company_id)` reads: an active block exists if
`starts_at <= now()` and (`ends_at is null` or `ends_at > now()`), scoped to that
Station or to the whole Organization. Block 6's draw eligibility calls it; nothing
maintains a status column, because a status column nobody maintains lies.

Archival is a different thing and is a state: `deleted_at`, the project's soft delete.
Archived Members leave the day-to-day lists and their history stays intact.

## 7. Erasure, and the audit trail underneath it

The master spec commits the product to LGPD erasure (§9) and to an immutable audit
trail. Both are right and they collide. The resolution the spec fixes (N4) is
**anonymisation**: the person is scrubbed, the record survives so that participations
and deliveries still reference something.

`anonymize_member(member_id, reason)` — elevated permission, audited:

- Nulls `full_name`, `phone`, `phone_normalized`, `email`, `email_normalized`,
  `cpf_hash`, `cpf_last_digits`, `passport`, `birth_date`, every address column and
  `discovery_source`.
- Sets `anonymized_at`. The row keeps its `id`, its `organization_id` and its links.
- Writes one audit entry naming the **event**, the actor and the reason — and no
  personal data.

**The rule that makes this true, and it binds every RPC in this block:** an audit
entry about a Member records the **`member_id`**, never the name, phone, e-mail or
document. Not "masked" — absent. Otherwise anonymisation scrubs the source table
while the audit trail quietly keeps a copy, and the product's erasure promise is
false in exactly the place nobody looks.

This is testable, and §13 tests it: after anonymising, **no `audit_logs` row for that
Member contains any of the erased values.** A test that passes only because the seed
data happened to be absent is not a test — it seeds a Member with distinctive values,
exercises every write path, anonymises, and searches.

*Carried forward:* Block 1c's report records that an internal **user** cannot be
deleted once they have acted, because five foreign keys reach `auth.users` with no
`on delete` behaviour. Anonymisation is the answer there too, and this block builds
the pattern it will follow. Doing it for internal users is not in scope here.

## 8. Operations

Every one is a `SECURITY DEFINER` function that re-checks the caller, resolves the
Organization from the row rather than a caller-supplied id, writes to `audit_logs`
with the `member_id` and no personal value, and on denial uses `RAISE LOG` then
`RAISE EXCEPTION`.

| Function | Requires |
|---|---|
| `find_member_by_identifier(org, phone, email, cpf, passport)` | `members.view` — §4; returns existence, and the id only when the caller may see it |
| `create_member(company, …)` | `members.create` — links the new Member to that Station |
| `update_member(member_id, …)` | `members.edit` |
| `link_member_to_company(member_id, company)` | `members.create` |
| `archive_member(member_id)` | `members.archive` |
| `record_member_consent(member_id, company, type, granted, origin)` | `members.edit` |
| `block_member(member_id, company?, kind, reason, ends_at?)` | `members.block` |
| `lift_member_block(block_id, reason)` | `members.block` |
| `anonymize_member(member_id, reason)` | `members.erase` |
| `add_member_note(member_id, company, body)` | `members.edit` |

## 9. Permissions

`module = 'members'`, `scope = 'company'`:

| Code | Label in the role editor |
|---|---|
| `members.view` | See the audience and their history |
| `members.create` | Register a listener and link them to this Station |
| `members.edit` | Edit a listener, record consent and add notes |
| `members.block` | Bar a listener from draws, or suspend them |
| `members.archive` | Archive a listener |
| `members.erase` | **Erase a listener's personal data permanently** |

`members.erase` is separated from everything else and labelled starkly. It is
irreversible, it is a legal obligation when a subject requests it, and it is the one
action in this block whose consequence cannot be undone by a person who regrets it.

## 10. Screens

**Members** (`/members`) — the Station's audience: search by name, phone, e-mail or
the CPF's last digits, filtered server-side, with the block state visible in the list
rather than one click away.

**Member detail** — identity, consents with their dates and origins, notes, block
history, and the Stations they took part in **that the viewer can reach**.

**Registration** — with the deduplication check on the identifying fields *before*
submission, so the three answers in §4 are what the person sees rather than a
constraint violation after the fact.

**Erasure** — behind `members.erase`, with a confirmation that states plainly what
survives (the participation and delivery history, pointing at nobody) and what does
not (everything that identifies the person). No screen offers to undo it, because
nothing can.

## 11. RLS

`members`: readable when the Member has a link to a Station the caller can reach —
`EXISTS` over `member_company_links` joined to `has_permission('members.view', …)`,
never `USING (true)`.

`member_company_links`, `member_consents`, `member_notes`, `member_blocks`: readable
under the same reachability test, and `member_notes` additionally scoped to the
Station that wrote the note.

No write grant to any role on any of them; every write is an RPC. `service_role` gets
`select` and nothing more.

## 12. Testing

**pgTAP** — the partial unique indexes exist with the `deleted_at is null` predicate
and the not-null term; the composite foreign keys reject a cross-Organization link;
no role holds a write grant; the six permissions are seeded Company-scoped; the raw
CPF has no column to live in.

**Isolation, under real JWTs, driven by a non-owner delegate:**

- Deduplication returns the id when the caller can see the Member, and **existence
  without the id** when they cannot — the §4 case, and the block's headline test.
- A Member linked only to Station B is invisible to a delegate holding
  `members.view` in Station A **who also holds a live membership in B under a role
  granting nothing**, so the refusal comes from permission resolution and not from
  the access gate.
- "Stations they took part in" omits a Station the viewer cannot reach.
- A suspension with a past `ends_at` no longer blocks; one with a future `ends_at`
  does; an indefinite one does.
- Each of the six permissions is refused without it and allowed with it.
- **After anonymisation, no `audit_logs` row for that Member contains any erased
  value** — seeded with distinctive values and searched for each.
- An archived Member's phone can be registered again without colliding.

**End to end** — a delegate registers a listener, records the rules consent, blocks
them until a date, sees the block, and a second delegate at another Station cannot
find that listener at all.

## 13. Definition of done

| Criterion | Evidence |
|---|---|
| Deduplication prevents a duplicate across the Organization | isolation |
| It does so **without revealing** a Member from an unreachable Station | isolation |
| A Member is invisible to a user with no access to any of their Stations | isolation |
| "Stations they took part in" shows only reachable Stations | isolation |
| A dated suspension expires with no job running | isolation |
| Anonymisation leaves no personal data in the source table | isolation |
| **Anonymisation leaves no personal data in the audit trail** | isolation |
| The raw CPF is stored nowhere | pgTAP |
| An archived Member's identifiers can be reused | isolation |
| Each of the six permissions gates its own operation | isolation |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` pass | CI |

## 14. Out of scope

Document images, the download proxy and per-view access logs — Block 6. Merging two
Members — Block 9, which is the first caller that needs it. The retention cron (N7) —
Block 11. WhatsApp consent — see decision 3. Anonymising internal users — noted in §7,
not built.

## 15. Open risks

1. **The dedup function is the one place that reads across the visibility boundary
   by design.** Every other cross-tenant path in this project is a defect; this one is
   a feature, which makes it the thing to review hardest. It must return existence and
   nothing else in the unreachable case — no id, no name, no Station, and no timing or
   error-shape difference a caller could use to learn more.
2. **The no-personal-data-in-audit rule is a convention until it is tested.** Every
   RPC in this block must honour it, and the test in §12 is what stops the eleventh
   one from quietly breaking it.
3. **`members.erase` is irreversible and reachable by a delegate** if the owner grants
   it. That is the owner's call to make per role, which is what Block 1c built — but
   the label must make the consequence unmistakable at the moment of granting, not
   only at the moment of using.
4. **Normalisation defines identity.** If `phone_normalized` treats two spellings of
   the same number differently, the dedup silently stops working and duplicates
   appear. It is generated in the database rather than in application code for that
   reason, and the rule needs a test of its own.
