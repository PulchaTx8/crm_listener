# The Station-rooted platform — tenancy, identity, and the person who is nobody's

**Date:** 2026-08-22
**Base:** `main` at `cab573e` — Block 31a (PR #95) merged, migrations through `0270`
applied to the hosted database.
**Supersedes:** the Organizations item of
`docs/superpowers/specs/2026-08-22-block-31-brief.md` and every ruling recorded
under it. What was called Block 31b — "move a Station between Organizations" —
does not survive this document as a piece of work; it survives as a consequence
that costs one column update.
**Status:** ARCHITECTURE. This is not implementable as one block and must not be
attempted as one. §11 decomposes it.

---

## 0. How this document came to exist

The owner asked a question about the shelved Block 31b: if a Station moved from
Organization A to Organization B, and years later wanted to return to A, what
would happen?

The answer was that the move has no inverse. Roles are destroyed on the way out
and again on the way back; the listener merge retires one record and returns a
different one, so the people who "come home" are not the rows that left; reports
stay with whoever generated them, so the series ends up split across two groups
and neither has all of it. A round trip does not restore A — it produces a third
state.

That answer inverted the question. The owner's next move was not to design a
better move; it was to ask whether the Station needs to be a structural
dependency of the Organization at all. Everything below follows from that, and
the original question dissolves along the way: §10 shows the move reduced to one
column and the return reduced to nothing.

The decisions in §3 were given in conversation on 2026-08-22 and are recorded
here for the reason Block 30d taught the project: a decision that lives only in a
transcript dies at the next `/clear`. §9 carries the owner's own words, unedited.

---

## 1. The model, in one page

**Today.** `Organization → Company → data`. Every multi-tenant table carries
`organization_id` and `company_id`. A listener is Organization-scoped identity
with per-Station visibility. Ninety-two composite foreign keys pin tenancy into
the key itself, so nothing can change owner inside one transaction.

**After.**

| Layer | What it is |
| --- | --- |
| Platform (PulchaTX) | Holds one row per person. That row carries **identifiers only** — no name, no birthday, no address. |
| Station (`companies`) | The tenancy root. Owns every operational record, its own listener profiles, its own staff access. |
| Organization | A grouping. Its users read every record of every Station in it and change nothing; it owns no operational record of its own. |
| Authorization | One row per (person, Station). It is what makes a person visible to a Station, and the person grants it by interacting. |

Three sentences carry the whole thing:

1. **A person becomes visible to a Station by interacting with it**, never by an
   operator deciding so.
2. **The person's own data is a live window** the Station reads through that
   authorization; **the relationship's data belongs to the Station** and does not
   move or vanish.
3. **The Organization reads everything and changes nothing** — every record of
   every Station in it, and no write at all — while the results of a period are
   frozen as they were apportioned at the time.

---

## 2. What this deliberately does not deliver, and does not change

- **No person-owned account.** The person does not log in to PulchaTX with a
  password and does not "own" a profile in the account sense. The platform holds
  the row; the person controls authorizations and can end them.
- **No shared blacklist.** A block or draw ban at one Station never crosses to
  another. This is stated as a prohibition rather than an omission — it is the
  worst thing this model could accidentally build.
- **No shared message consent.** Receiving a person's name does not authorize
  messaging them. Consent is per relationship and every Station collects its own.
- **No reach outside the group.** An Organization's users read everything in its
  own Stations (D19) and nothing whatever about a Station outside it. A Station
  never sees which other Stations a person authorized, and neither does an
  Organization.
- **No golden record.** There is no single authoritative name, birthday or
  address. Each Station keeps the profile it collected. The platform row holds
  identifiers and nothing else, which is what makes this true by construction
  rather than by policy.
- **No Organization-wide listener block.** It exists today and does not survive
  D17; a block is relationship data and only a Station can hold one.
- **No dependency on Meta approval.** Business-Scoped User IDs were considered
  and rejected in D12. Nothing here waits on an eligibility decision.

---

## 3. The decisions

### D1 — The Station is the tenancy root; the Organization is a consolidation grouping

Of the 50 tables carrying `organization_id`, 43 also carry `company_id`. Those 43
lose `organization_id`: there is nothing left to re-point. The 92 composite keys
`(company_id, organization_id) → companies(id, organization_id)` stop existing as
a problem, because nothing composite remains to defer.

The strongest argument for this is not the migration. It is that **moving a
Station stops being a transfer of personal data between controllers.** Today the
Organization is the controller and a move changes who that is. Here the data was
never the group's, so a move changes only who consolidates. The whole category of
LGPD problems the original study surfaced — consent that must travel, opt-out
that means one thing in one place and another elsewhere, erasure requested from a
controller that no longer holds the data — disappears rather than being solved.

### D2 — The person belongs to the platform, and the platform row holds identifiers only

One row per person, platform-wide. It carries the identifying claims and nothing
else: telephone, e-mail, CPF hash, passport. No name, no birthday, no address, no
discovery source.

`members` survives unchanged in purpose: it is the **per-Station profile**, with
the name that Station knows, the birthday it confirmed, the consent it collected.
It gains a pointer to the platform person.

This is the narrow reading of "shared base", and the narrowness is what makes it
survivable:

- The 14 tables carrying `member_id` do not change. They keep pointing at the
  local profile.
- The guarantee stated above `member_company_links` in `0031_members.sql:123` —
  *"The composite keys make a link between a Member of one Organization and a
  Station of another unrepresentable"* — is about the visibility table and
  survives untouched. What is added is an identity index above it, not a link
  between tenants.
- There is no contested golden record, because there is no single name for two
  Stations to disagree about.
- The platform table follows the strictest pattern the house already has: **RLS
  on with no policy, ACL revoked, reachable only from inside a `SECURITY DEFINER`
  body**. `0178_widget_link_tokens.sql:49` states this as the general rule —
  *"it names a listener, so it is reachable only from inside a SECURITY DEFINER
  body, the rule every listener-bearing table here follows."*

Deduplication becomes exact — two profiles pointing at one person are one human —
which retires the cross-boundary read that `0033_member_dedup.sql` exists to
perform.

### D3 — Interaction is authorization

A person becomes visible to a Station **at the moment they deliberately interact
with it**, and by no other means. The operator cannot create visibility. The
Organization cannot grant it. There is no consent form: the act of participating
is the consent, and the hashtag names its purpose.

**The origin Station's authorization is implicit and permanent.** Handing your
data to a Station is the authorization for that Station and for no other. Every
other Station needs an explicit one.

The existing base is therefore correct on the day this ships: every listener
already registered is treated as having authorized the Station that registered
them. No re-consent campaign, and nobody goes dark on the screen of the Station
that knows them.

### D4 — Two doors before the Widget, and MENU is removed

All interaction happens through the Widget, whether framed inside WhatsApp or
inside the Station's own site. Exactly two things can happen before the Widget
exists for that person:

1. A hashtag matching a **live, uncancelled promotion** of that Station.
2. The Station's **`music_hashtag`**.

Both register the person and both create the authorization. `service_hashtag`
(MENU) is removed from the product; the match order becomes promotions, then
music, and stops.

*For a future reader:* the owner sentence quoted in section 9 says the only
pre-Widget interaction is a promotion hashtag. The music hashtag was ruled in
separately, after that sentence, when the question was put directly. D4 is the
later ruling and it governs.

**Anything else links nobody.** A call, a message with no hashtag, a hashtag that
matches nothing, a hashtag whose promotion has ended — none of them create a
person and none of them are answered.

**This is already the behaviour of the code, not a change to it.**
`ingest_whatsapp_event` decides in the order Station → hashtag → listener, and
finishes at `no_hashtag`, `no_promotion`, `promotion_cancelled` or
`outside_window` before any listener is resolved, silently, which is design
decision D4 of the original WhatsApp spec. What this document adds is the removal
of the third hashtag and the ratification of the rest.

**The attempt still leaves a trace, and that trace is not a person.**
`webhook_events` keeps the payload and `prune_webhook_payloads` empties it at
thirty days, while the outcome stays on the event. A Station can therefore learn
that fifty people sent a hashtag after the window closed without any of them
entering the platform.

### D5 — Recognition with data, and the exact line of what may cross

When a Station a person has not authorized wants to recognize them, that is a
disclosure between controllers and is built as one:

- **The person authorizes, never a Station.** No operator and no group owner can
  release someone's data to another Station.
- **The refusal is indistinguishable from the unknown.** "Exists but did not
  authorize" and "does not exist" must be the same answer, or the authorization
  request becomes the existence leak it was meant to prevent. The precedent is
  `0164_widget_doors_respect_suspension.sql`, where a suspended Station and a
  blocked Organization both answer `unknown_installation`, *"indistinguishable
  from an unknown key."*
- **Person attributes may cross; relationship attributes never may.** Name,
  birthday, city and state cross. Blocks and draw bans (`0032`) do not — they are
  one Station's operational judgement about its own relationship, and a crossing
  ban is a shared blacklist. Notes, detailed address and CPF do not cross either.
- **Message consent does not cross.** See §2.
- **Every recognition is written to `audit_logs` on both sides**, so the person
  can later ask which Stations received their data.

### D6 — Person data is a live window; relationship data is the Station's

A copy cannot be revoked, so revocation only means something if what the Station
reads is a window.

- **Person data** — name, birthday, city, contact — is read through the
  authorization. Revoked, it goes dark.
- **Relationship data** — notes, blocks, message consent, discovery source,
  participations, pickups, music requests — belongs to the Station, stays there,
  and does not vanish when the person revokes.

### D7 — Business records stamp; revocation does not reach backwards

At the moment a prize is delivered, a participation recorded, a pickup closed,
the name of the person is **written into that row**. Otherwise a revocation years
later erases the evidence of a delivery that happened, and `sweep_retention`'s own
comment is explicit that business records are *"what a radio must prove
afterwards"*. The house already reasons this way: `anonymize_member` keeps the row
*"so participations and deliveries still reference something."*

Consequently, **revocation closes the future, not the past**. A person who has won
and not yet collected remains visible to that Station until the commitment closes,
with a deadline.

### D8 — Where the person acts

- **Revoking one Station** happens in that Station's Widget. It shows only that
  Station.
- **Revoking the platform** happens on the PulchaTX site, outside any Station's
  iframe.

The split is what protects the person: the full list of their Stations exists on
a page no Station frames, so exercising the right teaches nobody anything. A
Widget that listed a person's other Stations would be the competitor leak arriving
through the feature built to protect them.

**This obliges PulchaTX to hold its own WhatsApp number, WABA and templates.** The
platform page must prove who the person is, the only proof the product has is the
six-digit code, and sending it from a Station's number would bill that Station for
an action that is not theirs — `widget_request_code` is *"THE ENDPOINT THAT SPENDS
MONEY"*. It is the first standing monthly cost this design creates. The platform's
own door is also a new function: `widget_request_code` is installation-scoped and
the platform has no installation, and the IP-keyed limit lives in the Node layer
because *"the database has no idea what an IP is."*

**For most people, the per-Station revoke button is the platform erase button**,
because most people authorize one Station and D10 anonymizes the orphan. The
Widget must say so before the click.

### D9 — Suspension freezes; archiving ends

**Suspended Station** — no new participations, no new music requests, and
therefore no new person registers through its hashtags, until the status changes.
Nothing existing is touched; authorizations survive; the promotions are not
cancelled, only unreachable. When the suspension lifts, whatever is still inside
its window resumes.

**Archived Station** — every interaction it holds is archived with it:
participations and music requests alike. Its authorizations end, subject to D10's
window.

**Archiving closes the door, never the books.** A prize won and not collected is
still owed. Archiving prevents the new and freezes the existing; it deletes
nothing anyone could still be asked to prove.

**Where this bites today, measured:** suspension is already enforced at
`widget_frame_context`, `widget_request_code` and `widget_verify_code` since
`0164`, and the music hashtag already dies because it lives on the installation
record whose join tests `c.deleted_at`, `c.status` and `o.suspended_at`. **The
promotion hashtag is the only place it is not enforced**, because the pre-check
branch and the member resolution sit above both gates and have since `0179` —
written up verbatim in `0267`: *"a suspended Station still records a
participation, still enqueues a reply and still links a listener into a blocked
Organization — older than this block, not closed by it, and written up in the task
report with the lines that would change."* Closing that one place closes all of it.

Cascading the archive to promotions also closes that hole structurally: with the
promotions gone, the hashtag matches nothing and the resolution is never reached.
**Both are still wanted.** The cascade is the product rule; the gate is what makes
the rule true regardless of ordering, of a promotion created after the archive, or
of a message in flight racing the act.

### D10 — The orphan person

A person with **no live authorization** — the last Station archived, or they
revoked everything — is anonymized through the path that already exists,
`anonymize_member`. Business records keep the name stamped by D7.

Two clocks, and the asymmetry is deliberate:

- **They revoked** — their own act. Immediate.
- **Someone archived the Station** — another's act. A window of regret: the
  anonymization runs N days later, and un-archiving inside the window cancels it,
  as does the person authorizing any other Station.

The window turns the rule into a **state** — "no authorization since X, erasure in
N days" — and that state is what the platform page shows the person, which is both
honest and their last chance to avoid it.

This finally gives `anonymize_member` a trigger. It has existed since Block 3 and
fires from no door; the erasure obligation is written into the database and never
runs. Here it runs by rule rather than by request.

**On anonymization, retain the opaque WhatsApp identity key and the erasure date,
and nothing else.** It is high-entropy, unlike a telephone hash, which brute-forces
in minutes because the number space is small. It carries no name and no attribute
and links to no profile. Its single purpose is to let the platform recognize later
that the account behind a number changed.

### D11 — Consolidation is frozen by period

A closed period keeps the group's numbers **as they were apportioned at the time**,
with the Station named in the composition. From the current period onward, a
departed Station no longer appears.

- The group never sees last year change by itself, and never sees new data from a
  Station that is no longer its.
- **The frozen record must name its composition**, not only its total. A number
  that does not match today's roster and does not say why reads as a defect, and
  somebody will "fix" it.
- **The frozen record is numbers, never rows.** A snapshot holding winners or
  named listeners stops being an aggregate and becomes the group retaining
  personal data from a Station it no longer owns.

This costs a **period close**: the Block 8a dashboards aggregate live today, and a
live aggregate over a closed period is exactly what changes when a Station leaves.
Half the machinery exists — a `report_runs` row is a snapshot by nature — and what
is missing is the dashboard reading the frozen record for closed periods and
computing only the open one.

**Ruled by D19:** while a Station is in the group, the group's users read its
records live, because the grant is computed from present membership. Of a Station
that has left, they keep the frozen numbers and nothing else — the live read ends
in the same instant the column changes.

### D12 — No BSUID. Identity is the pair (number, identity key)

Business-Scoped User IDs were investigated and **rejected**, because parent BSUIDs
— the only variety that identifies a person consistently across business
portfolios — require Meta to find the business eligible, and the design must not
rest on an answer that can come back no.

What is used instead needs no approval:

| What changes | Reading | Action |
| --- | --- | --- |
| Number changes, identity key the same | same person, new number | **follow** — the old claim ends immediately |
| Number the same, identity key changes | a different account holds it | **split** — a stranger; nothing revealed |
| Both change | nobody known | new registration |

Two signals carry it, both already available:

- **`enable_identity_key_check`**, set through `POST /{phone-number-id}/settings`.
  With it on, Meta verifies the customer's identity hash before delivering and the
  hash arrives in the payload. This is the control that stops whoever bought the
  recycled SIM from resolving as the previous owner.
- **The `user_changed_number` system message**, on the `messages` webhook field
  already subscribed, carrying a body that names both numbers, with the message arriving from the
  OLD number and the new one in `system.wa_id`. This is what lets a person keep their history across a number change
  with nobody doing anything.

Note plainly: `wa_id` **is** the telephone number, per Meta's own reference — *"the
user's phone number or omitted if username feature is enabled"*. Using it in place
of the telephone would have solved nothing.

**Honest failure mode.** The identity key rotates when a person reinstalls
WhatsApp or changes device, so the split will sometimes fire on a legitimate
person. It fails on the safe side — it locks the rightful owner out rather than
letting a stranger in — which is why D14 exists and is not optional.

### D13 — Telephone and e-mail are claims, not columns

A claim is a row: the value, the identity key that sustained it, when it started
and when it ended. As a column, two people end up asserting the same number and
the unique index decides by accident of arrival — the one who got there first
wins, even when they are the one who left. As a claim, the old number closes with
a date, the new holder enters clean, and the closed row keeps explaining the past
without competing for the present.

E-mail is a claim for the same reason: addresses are reassigned too, especially on
corporate domains where a successor inherits the mailbox.

**Silence demotes.** When neither Meta signal arrives — the person changed number
without migrating the account — a claim that has gone N months without any
interaction stops being sufficient on its own to resolve a person. A message from
it starts a fresh registration. N is measured against how long a Brazilian carrier
actually takes to reassign a number, not against how long somebody goes without
entering a promotion.

### D14 — Recovery: two channels, two proofs

The person proves the **new** number with the WhatsApp code, and proves the **old
record** with a code sent to its e-mail. Whoever bought the SIM has the first and
not the second; whoever learned the e-mail has the second and not the first.

- **E-mail is a channel, never a typed match.** "Type your e-mail and if it
  matches, the account is yours" is weaker than CPF, because addresses are more
  public. The whole value is the round trip.
- **CPF is a secondary factor and never a path.** In Brazil the CPF is not a
  secret — it is on invoices, on pharmacy counters, and in every leak of the last
  decade. Whoever has a reason to steal an account can find it. It strengthens a
  path; it never opens one.
- **A person with no verified e-mail has no automatic recovery.** Inventing a weak
  substitute — participation history, "which promotion did you enter" — hands the
  attacker the same road. Better to say there is no path than to build one the
  attacker also walks.
- **Only a verified e-mail counts.** `member_field_confirmations` already records
  that a person *confirmed* a field, which is currency, not control: they said the
  address is right, nobody proved they receive it. The shape is adjacent, the
  meaning is not, and reusing it as proof would build recovery on a confirmation
  that confirms nothing.
- **Recovery is audited and announced.** It moves an entire history to a new
  number, so it writes to `audit_logs` and notifies the person on both channels,
  including the old one. A successful hijack still leaves a trail and a warning.

CPF keeps its real value elsewhere: as a **merge** signal it is the strongest the
product has, because it survives a change of number and of e-mail. Recovery and
merge are two different problems using two different signals.

### D15 — E-mail verification at first participation; the entry does not wait

The verification is asked at the **first participation in a promotion**, not at
registration. Somebody who only requests music has nothing to dispute and should
not pay for a protection they do not use.

The risk is created by the prize rather than by the entry, but verifying at the
win is too late — the winner is already against the pickup deadline and a failed
verification there costs them the prize. Asking at the first participation moves
the friction to a moment where it costs nothing.

**The entry does not wait for it.** The person sends the hashtag and enters
immediately, including through the fast path that records and answers with no
screen at all. The verification is requested at that moment and becomes
**required before a prize can be delivered**. Nobody loses a promotion over an
inbox, and the proof exists before it is needed.

### D16 — The platform's refresh clock

Anyone who has **ever** participated in a promotion owes a periodic
re-confirmation, independent of what any promotion asks. It is a one-way latch:
music-only people are exempt until the day they enter a promotion, and from that
day forward, never retroactively.

**Scope: contact and identification.** `full_name`, `birth_date`, `cpf_hash` /
`cpf_last_digits`, `passport`, `phone`, `email`. Outside it: address, discovery
source and sex, which a promotion asks for when it needs them and which live under
that promotion's own clock. If a promotion ever ships a prize by post, that
promotion's clock covers the address.

Of those six fields, **only two decay**:

- `phone` **confirms itself** — every arriving message proves the number and the
  identity key proves the account. Asking somebody who just wrote whether that is
  still their number is friction with no information in it.
- `cpf`, `passport` and `birth_date` **do not change**; they are only corrected,
  and a periodic prompt does not surface an error nobody noticed.
- `email` and `full_name` remain.

So the platform clock is, in practice, **a proof that the e-mail is still alive**,
with a chance to fix the name — which is exactly what it exists for, since the
only thing it protects is the recovery path. And the strongest way to know an
address still lives is not to ask but to **send a code and see it come back**: the
periodic confirmation is the same round trip as the first verification. One
machine, used twice, and "update your details" stops being a form filled on
autopilot and becomes a proof.

**Two clocks will cover the same field.** Block 5b already decided per-promotion
data validity in months. Where a promotion says six and the platform says twelve,
**the stricter one wins**. Without that written down it becomes a defect nobody
can explain two years from now.

**Missing the deadline blocks new promotion participation, and nothing else.** The
obligation was born of promotions, so the consequence lands there. Music requests
keep working, the account stays alive, and the person meets the requirement at the
moment they care about it.

### D17 — Staff belongs to the platform; access belongs to the Station

The same move as D2, applied to the other end: the **identity** rises to the
platform, the **relationship** descends to the Station. Half of it is already
true — `auth.users` has always been global — and the other half already has a
table: `company_memberships` (`user_id`, `company_id`, `role`) has sat beside
`organization_memberships` since `0003_identity_tenant.sql:63`.

- **A user belongs to the platform** and may be staff at any number of Stations,
  including Stations in different Organizations. Nothing about that is a leak:
  each Station's data is its own, and the console switches context.
- **A Station's owner-user sets that Station's rules.** Not the group's.
- **The rules travel with the Station**, because they were never the group's to
  begin with.

**All six Organization-level permissions descend.** The whole list, measured:
`users.manage`, `users.invite`, `roles.manage`, `members.view`, `members.block`,
`audit.view`. Five of them keep their meaning one level down. **One loses its
subject:** the Organization-wide listener block, which `0032` expresses as a block
row with a null `company_id`. A block is relationship data (D6) and only exists
per Station, so "block across the group" stops being a concept and becomes, at
most, a screen convenience that applies the same block at each Station the
operator administers. That is a real loss of function and is recorded as one.

**`is_owner()` becomes `is_station_owner()`.** It reads `organization_memberships`
for `role = 'owner'` today and is called **42 times across 19 migrations**. It
becomes a read of `company_memberships`. This is the single largest mechanical
change in the staff work, and it is bounded: a rename plus a table swap.

**Role definitions must become Station-owned, and that duplicates.** Today
`roles_name_unique` is `(organization_id, lower(name))`: the definition is the
group's, the assignment is per Station (`0015_roles.sql:51`). A definition that is
shared cannot travel, so it has to descend — and a group with eight radios then
defines "Gerente" eight times. The friction is removed by **platform-level role
templates copied at Station creation**, never by sharing one definition. Copy is
right here for the same reason a window was right in D6, inverted: what must
survive a change of owner cannot be a pointer at something the previous owner
holds.

**Invitations become Station-scoped, and must not reveal the platform.**
`invitations` carries an e-mail and is Organization-scoped today
(`0012_invitations.sql:9`). Descending it means inviting somebody who is already a
platform user, and an autocomplete or a "user already exists" message would leak
that they exist and hint at where they work. **A Station learns nothing about
where else its staff work.** The invitation answers identically for an address new
to the platform and one already on it — the `elsewhere` rule of `0033`, now on the
staff side.

**On a move, staff travels and the destination confirms.** The announcers and
promotion staff work at the radio, not at the holding company, so wiping their
access would stop the Station on its first day under new ownership. But the seller
— the group owner who was also registered as owner-staff of that Station — would
otherwise keep walking in. So the move **presents the staff list and the
destination's owner confirms or revokes each one.** This keeps the purpose of the
owner's ruling of 2026-08-22 (the operation prints the current rules first) and
inverts its mechanism: it prints them so they can be kept deliberately, rather
than recreated from nothing.

**What an Organization user is, after this**, is D19: they read everything in the
group's Stations and change nothing. `organization_memberships` survives as
exactly that grant, and carries no role, because roles are a Station's.

What descends here is **authority**, not sight. A group user sees every screen; a
group user changes nothing on any of them, and creates, archives and moves no
Station (D18).

### D18 — A Station's lifecycle is a platform act, and a Station may have no group

**Only the platform admin creates, moves and archives a Station.** Creation is
already exactly this: `provision_organization` states that it creates the group
and its owner and *"NO Station -- how many radios a customer has is not known at
provisioning time"*, and `add_company`, the door each radio actually enters
through, has been gated on `is_platform_admin()` since `0017`. The ruling
ratifies the code.

Two things follow:

- **The move screen leaves "Edit Organization".** The original Block 31b brief
  put it there, which implied the group owner performing it. Creating a Station is
  a commercial act of PulchaTX; moving one is the same act seen from the other
  side. It belongs in the platform console, which Block 16 already split into
  Organizations and Stations.
- **Archiving goes with them.** Archiving now starts the orphan clock (D10) and is
  the most destructive act in the product — one click can anonymize thousands of
  people. Keeping creation on the platform while leaving destruction with the
  customer would be the wrong half.

**`companies.organization_id` becomes optional.** A grouping that is only a
grouping is an option, not a requirement, so an independent Station stops needing
a one-member Organization built to satisfy a foreign key. This costs almost
nothing now: under D1 the 43 mechanical tables lose the column anyway, so the
group survives in `companies` alone. And it makes representable something that is
not representable today — **a Station leaving a group without joining another**,
which is what happens when a group dissolves or a radio goes independent.

### D19 — The Organization grant: one level, reads everything, changes nothing

An Organization has users, plural, and they are all alike: **they read every
record of every Station currently in the group, and they change nothing.** No
Organization roles exist — membership in the group is the entire grant. That is
what keeps D17 whole: a role is a Station's thing, and there is no second level
for one to live at.

Reading means reading: the dashboards and their Station pills, the reports, the
audit trail, the listener grids and the listener cards. Changing means anything
that alters what a Station does — creating or ending a promotion, touching
inventory, editing settings, registering or blocking a listener, sending a
message. None of that.

**It lands inside `has_permission(code, company_id)`, and nowhere else.** That
function answers true, additionally, when the caller is a user of the
Organization the Station currently belongs to and the code is a read. Everything
downstream keeps working untouched — the RLS policies, the pills, the 42501s, the
`reports.consolidated` check the dashboards already make per Station.

This has to be an ordinary answer from that function rather than a bypass around
it, because the dashboards are **`SECURITY INVOKER` by design**: `0118` says the
failure mode of a `DEFINER` aggregate is *"a count that silently includes rows the
caller may not read, which looks like a number rather than a defect."* An
Organization reader whose access lived outside RLS would produce exactly that
number.

**Computed from present membership, never materialized.** No access rows are
written for group users at each Station. If they were, a Station leaving the group
would need them cleaned up, and the seller keeps reading whatever the cleanup
forgets. Computed, the access ends in the same instant `companies.organization_id`
changes — nothing to run, nothing to forget.

**The read set is a fact in the catalogue, not a list inside a function.** The
`permissions` table gains a read/write mark, and the grant confers the read ones
by data. A hand-kept list drifts the first time a block adds a write code and
nobody remembers to exclude it; a column cannot.

**"Changes nothing" means no operational state, not no `INSERT`.** Reading writes
in this product: generating a report writes a `report_runs` row, revealing a
masked field writes audit, an export writes audit. Those are permitted, and the
audit ones are required. Read literally as "performs no insert", this rule would
stop an Organization user from generating a report, which is the main thing they
are there to do.

**Masked fields follow the Station's rule exactly** — the group reader sees what a
Station reader sees, reveals what a Station reader may reveal, and leaves the same
audit row. No special case in either direction.

**What this costs, stated rather than discovered.** When a Station joins a group,
that group's readers see every listener it has, including people who authorized it
years earlier under a previous owner. It is coherent: the person authorized *the
Station*, and it is the same Station — what changed is who owns it. No fresh
authorization is owed, because D5 governs a *different* Station asking, not the
same Station under new ownership. This is the one place where "the data never
changes controller" meets "a new set of humans may now read it", and the answer is
that this is what buying a business with its customer list means.

*Text to correct in passing:* `0010_permissions.sql:28` describes `audit.view` as
*"Read the Organization's audit trail"*. Under D17 and D18 it is the Station's.

---

## 4. What the schema makes hard, measured rather than assumed

Numbers taken from the tree at `cab573e`:

- **50 tables** carry `organization_id`; **43** of those also carry `company_id`.
- **7 tables are Organization-only:** `companies`, `members`, `roles`,
  `organization_memberships`, `invitations`, `member_field_confirmations`,
  `report_runs`. Every difficult question in the original study was one of these.
- **92 composite foreign keys** pin tenancy into the key, none `DEFERRABLE`, none
  `ON UPDATE CASCADE`.
- **14 tables** carry `member_id`.
- **72 RLS policies**, and **116 of 152** database functions reference
  `organization_id`.
- **44 of 475** application files reference `organization_id` / `organizationId`.

The weight is in the database, not in the application. This is a re-founding of
Blocks 1a and 1c with 270 migrations of assumptions resting on them, plus an
authorization axis those blocks never had.

---

## 5. LGPD posture, stated once

- **The controller does not change when a Station changes group.** That is D1's
  real prize, and it removes the entire consent-transfer problem the original
  study surfaced.
- **The platform holds an identity index across controllers**, not a national
  database of named listeners. That is a real new posture and it is deliberately
  the smallest one that makes the model work: identifiers only, D2.
- **Erasure is complete from the Station's side immediately** and complete
  globally when the last authorization ends, D10 — which is also the first time
  this product's erasure path actually fires.
- **Recognition between Stations is a disclosure**, built with the person's
  authorization, an indistinguishable refusal, a bounded set of attributes and an
  audit row on both sides, D5.
- **A person with no live authorization is personal data with no purpose**, which
  is the category the law says to discard, and D10 discards it.

---

## 6. What was left open, and how it closed

The owner closed the architecture on 2026-08-22 and asked for the remainder to be
settled. **The four below are Claude's calls, not the owner's**, taken because the
design already implies them; each says what would change if it were taken the
other way. The fifth is not a decision at all.

**6.1 — The orphan window is 30 days.** It matches the short clock
`sweep_retention` already runs on three operational tables, so no new cadence
enters the product, and the sweep that would run the anonymization is nightly
already. Longer keeps personal data with no purpose alive for no reason; shorter
makes an accidental archive unrecoverable in a working week.

**6.2 — Silence demotes a telephone claim at 12 months.** The claim must outlive
the carrier's quarantine before reassignment, and the failure modes are not
symmetric: too short demotes a real person who simply did not enter a promotion
all year, and they recover through D14; too long leaves a reassigned number
resolving to its previous holder, which is the thing D12 exists to prevent — but
the identity-key check catches that case independently, so this clock is the
backstop and not the guard. Twelve months errs toward not annoying the living,
with the guard elsewhere. **Confirm against the current ANATEL rule before P3
ships**; if the quarantine is longer than twelve months, this number is wrong.

**6.3 — A period is a calendar month, resolved at each Station's own clock.** The
dashboards already work this way: `0118` returns each Station's own resolved from
and to dates beside its timezone, precisely because a preset resolves differently
in distant zones on a month boundary, and it names the Stations that disagree
rather than claiming a uniformity it cannot provide. The freeze inherits that
behaviour rather than inventing a second calendar beside it.

**6.4 — E-mail confirmation is requested at first participation, not required.**
The person enters the promotion either way, is told plainly that without a
confirmed address their account cannot be recovered, and is asked again by D16's
clock for as long as they keep participating. Requiring it would exclude from
promotions everybody without an e-mail — an audience loss the Station pays for —
and it would be **redundant**, because D15 already puts the hard requirement where
the risk actually is: **no prize is delivered without it.** The gate belongs at
the prize, and it is already there. Taken the other way, the entry itself would
refuse, and the fast path — which records and answers with no screen at all —
would have to grow a screen.

**6.5 — The backfill census is not a decision, it is P0.** How many profiles in
production match across Organizations by telephone, e-mail, CPF or passport. Its
answer sizes P2 and can change P2's design, and it is the cheapest thing in the
programme. It must be measured before P2 is planned.

## 7. What the owner has to do, and when

- **Provision PulchaTX's own WhatsApp number, WABA and templates** (D8). Standing
  monthly cost. Needed before the platform revocation page and before any
  platform-level message.
- **Enable `enable_identity_key_check`** on every Station phone number (D12).
- **Decide the items in §6** that are decisions rather than measurements.

---

## 8. Debt this closes, and debt it records

**Closes:**

- `anonymize_member` finally has a trigger (D10). The unfulfilled erasure
  obligation ends here.
- The `0267` hole — a suspended Station still recording participations and linking
  listeners into a blocked Organization — is closed twice over (D9).
- Block 31b, as a piece of work, ceases to exist (§10).

**Records:**

- The identity key's false positives lock legitimate people out on device change
  (D12), mitigated but not removed by D14.
- A person with no verified e-mail is unrecoverable by design (D14).
- The platform becomes an identity index across controllers (§5).
- The Organization-wide listener block is retired, not replaced (D17).

---

## 9. The owner's words, unedited

Recorded in the language they were given, for the reason
`2026-08-22-block-31-brief.md` gives: a request paraphrased is a request
half-lost. These are the sentences the decisions above argue from.

> E se a Station deixasse de ser uma dependência estrutural de Organization.
> Organization passaria a ser um agrupador para consolidação de resultados,
> apenas. [...] Porque tudo que é da Station continua com a Station e a
> Organization deixaria de ver os dados da Station.

> E se o ouvinte passasse a pertencer ao sistema, e não a uma station ou a uma
> organization?

> Uma autorização por emissora. A pessoa só é visível para a emissora se ela deu
> autorização. Inclusive, a autorização passa a ser o ponto de visibilidade dos
> dados da pessoa para a Station.

> Toda pessoa irá se cadastrar no sistema vindo a partir de uma interface de input
> de uma station. Isto é, ou a pessoa vai mandar uma palavra em hashtag para o
> número de alguma Station, ou vai entrar via Widget pelo site da Station. Então,
> a pessoa passa a ser visível a uma Station a partir do momento que interagiu com
> ela. A pessoa pode revogar seus dados por Station ou por toda a plataforma.

> A pessoa só passa a fazer parte da plataforma se mandar um hashtag existente e
> ativa em uma Station. Apenas o fato de ligar ou mandar uma mensagem sem
> correspondência de hashtag em promoção ou pedido de música ativas no número de
> telefone da Station, não a vincula automaticamente. Dessa forma, podemos deduzir
> que a pessoa está intencionalmente querendo participar de uma promoção válida ou
> mesmo pedir música naquela Station, e isso gera o cadastro na base de dados da
> plataforma e a autorização pela Station.

> Não usaremos mais MENU. Toda interação será via Widget, seja do Whatsapp, seja
> do site (iframe). A única interação que pode ocorrer antes do Widget é quando
> uma hashtag é enviada diretamente para uma promoção ativa de uma Station.

> Uma station que foi dado baixa terá todas as promoções ainda contidas dela e com
> período ativo, dado baixa em conjunto. [...] A suspensão de uma Station apenas
> congela a entrada de novas participações em promoções e pedidos de música.

> A revogação da plataforma seria feito através do site da Pulchatx. A revogação
> da Station seria no Widget dela.

> Não vamos usar o BSUID. Não quero correr o risco de esperar uma resposta que
> pode ser negativa.

> O código através do email como confirmação, fica quando a pessoa participa pela
> primeira vez de uma promoção. Se a pessoa não participou nenhuma vez de uma
> promoção, a perda da conta não gera ônus de disputa. [...] Depois disso,
> precisamos colocar um prazo para que ela atualize seus dados independente de ser
> dado requisitado por promoção. [...] Se ela só pediu música, não precisamos
> disso.

Rulings given as answers to a direct question, in the order they were given:
platform-owned shared base; recognition with data; implicit authorization at the
origin Station; the music hashtag keeps registering; the orphan leaves with the
last authorization; archiving ends authorizations with a window of regret; frozen
history and absence from the present; CPF becomes a secondary factor; the refresh
clock covers contact and identification.

---

## 10. The original question, answered

**Moving Station S from Organization A to Organization B, in this model:**

1. Update `companies.organization_id`. That is the whole data operation.
2. People do not move. They were never A's.
3. Authorizations do not move. They are person→Station and the Station is the same
   Station.
4. Participations, music requests and pickups carry `company_id` and stay with the
   Station.
5. The audit trail travels, and **this stops being a leak**: it is the Station's
   operation and the Station is a business that changed hands. The books go with
   the business.
6. Consolidated results are frozen per period (D11), so A keeps what it earned and
   stops accruing what it does not own.
7. **The only work is ending the source's staff access** (D17).

**And the return, years later?** Nothing was destroyed on the way out, so there is
nothing to restore on the way back. The operation is its own inverse — which is
precisely what it was not when the question was asked. The three irreversible
losses that opened this study are gone: roles and listener identity because the
data stopped being the group's, and reports because they are the group's on
purpose and are now frozen as such.

---

## 11. Decomposition

Each block below gets its own spec, its own plan and its own PR. The order is
load-bearing: every block leaves the product working, and no block depends on one
that comes after it.

| # | Block | Why here |
| --- | --- | --- |
| **P0** | **The census.** Measure the cross-Organization identifier collisions in production (§6.5). No schema change. | Its answer sizes P2 and can change P2's design. Cheapest thing in the programme. |
| **P1** | **Close the `0267` gate.** The promotion hashtag stops registering for a suspended Station or blocked Organization. | Independent of everything, valuable alone, and the lines are already identified by a previous review. |
| **P2** | **The platform person.** The identifiers-only table, `members.person_id`, the backfill, resolve-or-create inside `0061_member_resolution_cores.sql`. | The foundation. Lands in one shared body, which is why the four doors cannot drift. |
| **P3** | **Claims.** Telephone and e-mail become rows with validity and identity key; `enable_identity_key_check`; `user_changed_number` and follow/split. | Needs P2's person to attach to. |
| **P4** | **Authorization.** The (person, Station) row, implicit at the origin, created by interaction; MENU removed. | Needs P2. Visibility still reads the old axis at this point. |
| **P5** | **Staff and ownership.** `is_owner` becomes `is_station_owner` across 42 call sites; `company_memberships` becomes the grant; roles descend with platform templates; invitations go Station-scoped and blind; the six permissions descend; the Organization-wide block is retired; and `has_permission` absorbs the computed Organization read grant (D19) with the read/write mark on the catalogue that makes it safe. | Depends on nothing in P2-P4 and could run straight after P1. It must precede P6, so the listener policies are rewritten once against the converted helper rather than twice, and P7, which takes away the argument `is_owner` reads. |
| **P6** | **Visibility inversion.** RLS reads the authorization; person data becomes a window; relationship data stays. | The dangerous one. Needs P4 proven and P5 landed, since the listener policies it rewrites also test ownership. |
| **P7** | **Tenancy inversion.** Station becomes the root; the 43 tables drop `organization_id`; the 92 composite keys go; `companies.organization_id` becomes optional. | Deliberately after visibility and ownership, so only one axis is in motion at a time. |
| **P8** | **Lifecycle.** Suspension and archiving semantics, the archive cascade, the orphan clock, `anonymize_member` firing, archiving moved behind the platform admin. | Needs P4's authorizations to end. |
| **P9** | **The person's surfaces.** Per-Station revocation in the Widget, the PulchaTX platform page, PulchaTX's own WABA. | Needs P4 and P8. |
| **P10** | **Recovery and the clocks.** E-mail verification at first participation, two-channel recovery, the platform refresh clock. | Needs P3 and P9. |
| **P11** | **Recognition with data.** Cross-Station authorization requests, the bounded attribute set, the indistinguishable refusal, both-sided audit. | The only block that opens a new disclosure. Last on purpose. |
| **P12** | **Frozen consolidation.** Period close, composition recorded, dashboards reading snapshots for closed periods. | Independent of the identity work; can run in parallel from P7 onward. |
| **P13** | **The move.** One column, the staff list presented for confirmation, and the screen living in the platform console. | The original Block 31b, reduced to this. Needs P5 and P7. |

**P0, P1 and P5 can start immediately.** P5 depends on none of the identity work,
only on `company_memberships`, which `0007`, `0013`, `0017` and `0018` already
populate. P2 waits on P0''s census and on nothing else; every other §6 item is
settled.
