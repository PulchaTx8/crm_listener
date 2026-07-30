# Block 4c — Participations, import, and the limit N3 guards — Design

The last of Block 4's three passes. **4a** shipped the promotion and its quiz
(PR #15, merged). **4b** shipped prize linking and the surgery on the ledger
(PR #16). **4c** is this: participations arrive, by hand and by file, and the
rules that decide whether one counts finally have a table to act on.

This pass is where three promises written into shipped code come due. It is also
where a fourth thing gets corrected — the project has been reading
`require_correct_answer` wrong since 4a, and §2 D2 says how.

---

## 1. What earlier passes left for this one

**4a's D9 — the quiz freezes once a participation exists — has never been
enforced.** `update_promotion` (`0042:193`) carries a comment saying so out loud:
the guard would have had to consult a table that did not exist, and this project
has shipped five guards that could never fire. `0041`'s table comment makes the
same promise from the other side: `promotion_questions` carries no `deleted_at`
because a question may only be removed while the promotion has no participation.
Both are 4c's to implement and to prove red under mutation.

**`require_correct_answer` has no consumer.** 4a shipped the column and nothing
reads it. §2 D2 explains why that is not the defect it looks like.

**N3 has no implementation.** The v1 design (§10) requires the repetition rules
to be validated transactionally, under a lock on `(promotion, member)`, and
reinforced by a constraint, so that near-simultaneous messages cannot break the
limit. Nothing has needed it until now.

**There is no column for a per-person ceiling.** The v1 design names "limit per
person" as a rule; 4a shipped `allow_multiple_entries` and
`min_hours_between_entries` and nothing else. D1 settles it.

---

## 2. Decisions taken with the owner

**D1 — A promotion may cap how many times one person enters.** `promotions`
gains `max_entries_per_member`, meaningful only when the promotion already
allows repeats. "Pode repetir, de seis em seis horas, até cinco vezes" is a
sentence the two 4a fields could not express.

**D2 — `require_correct_answer` is a draw rule, not an entry rule.** This is a
correction, not an addition. The project has been treating it as a filter on the
way in — a participation with a wrong answer would be refused — and that is not
what the owner meant by it. **Nobody is refused for answering wrongly.**
Everyone who participates is recorded. The flag is read at the draw (Block 6),
where it decides who is in the pool: everyone, or only those who answered
correctly. Correctness is therefore never a participation status; it is an
attribute of an answer, read later.

**D3 — The answer is stored; the correctness is derived.** One row per answered
question, naming the option chosen (or the text, for an essay). Block 6 works out
who was right by joining `promotion_question_options.is_correct` at draw time.
A denormalised "answered correctly" on the participation would be a second place
telling the same truth, and this project spent the whole of 4b reconciling a
projection against the ledger for exactly that reason. **4a's D9 freeze is what
makes deriving it safe**: an option cannot be reworded after somebody chose it,
so the join means the same thing tomorrow as it did at entry.

**D4 — Both doors register the listener when they cannot find one.** Manual
entry and import search by phone and CPF through the deduplication Block 3
already owns, and create the listener when there is no match. The alternative —
refuse and send the operator to the audience screen — turns a spreadsheet with
fifty unknown people into fifty round trips at the worst possible moment.

**D5 — A refused attempt is stored, and its status says why.** It does not
vanish, and it needs no separate reason column — §3.2 explains why one enum
carries both facts. This
is the v1 design's own rule (§10 N3), and Block 5 will have no choice about it:
a message arrived, and what happened to it has to be on the record. Building it
now means Block 5 adds a source, not a column and a second write path.

**D6 — Import is one step.** It writes what it can and reports what it skipped,
with the line number and the reason. No preview-and-confirm stage.

**D7 — An import row carries identification and when it happened.** Name, phone
and/or CPF, and `participou_em`. **The timestamp is not decoration**: the minimum
interval measures against it, and a historical spreadsheet stamped "now" on every
row would refuse its own second entry for a person, giving a reason that is not
true. Rows carry no answers, so a promotion that draws only among correct
answers will exclude everything imported — the screen says so before writing.

**D8 — Participations get their own screen; the promotion record gets a small
tab.** `/participations`, keyset-paginated and filterable by promotion, in the
shape Block 3b built for the audience. The record dialog's fifth tab shows the
count and the two buttons and links out. The record is read once per opening
(Block 3c), and a promotion with eight thousand participations cannot be read
once per opening.

**D9 — The lock is an advisory transaction lock on the pair.** See §4.

**D10 — Import requires `members.create` as well as `participations.import`.**
Import registers listeners. Without this, `participations.import` is a side door
that registers six hundred people for somebody who may not register one.

It requires `members.view` too, and that one is inherited rather than chosen:
resolution goes through `find_member_by_identifier` (`0033`), which is gated on
`members.view` across the Organization. Reimplementing the lookup to avoid the
dependency would mean re-deriving the phone and e-mail normalisation that
`0031`'s own comment warns must never be hand-copied. Requiring it is also the
right answer on its face — registering listeners in bulk without being allowed
to see one is not a coherent power.

---

## 3. Data model

### 3.1 `participations`

`id`, `promotion_id`, `member_id`, `organization_id`, `company_id`,
`allows_multiple`, `status`, `source`, `participated_at`, `created_by`,
`created_at`. `allows_multiple` is denormalised from the promotion and is not a
convenience — §3.5 is the whole reason it exists, and the foreign key there is
what stops it from drifting. No `updated_at` and no
`deleted_at`: a participation is a thing that happened. It is not edited and it
is not withdrawn — a mistake is corrected by recording the truth beside it, the
same reasoning `inventory_movements` carries.

Two composite foreign keys, each proving something in one constraint rather than
by convention:

```sql
foreign key (promotion_id, company_id) references promotions (id, company_id)
foreign key (member_id, company_id)    references member_company_links (member_id, company_id)
```

The second is the stronger of the two and is worth naming: `member_company_links`
is keyed on exactly that pair, so this proves in one place that the listener
exists **and** is attached to this Station. Going to `members (id,
organization_id)` instead would prove only that they belong to the Organization,
and an Organization with two Stations would let a participation name somebody the
Station has never heard of.

### 3.2 `status`, and why it is one column rather than two

`participation_status` is an enum: `VALID`, `DUPLICATE`, `TOO_SOON`,
`OVER_LIMIT`.

**This refines what was sketched during brainstorming**, which had three values
and a free-text `invalid_reason` beside them. Two problems with that shape. The
reason would have to be parsed to answer "show me everything refused for coming
in too early", which is a question the screen will be asked. And `DUPLICATE`
would appear both as a status and as a reason, so two columns would encode one
fact and could disagree. One enum, four outcomes, no overlap.

`source` is its own enum — `MANUAL`, `IMPORT` — with `WHATSAPP` added by Block 5.
It is deliberately not folded into `status`: how somebody entered and whether it
counted are independent, and every combination of the two is real.

### 3.3 `participation_answers`

`id`, `participation_id`, `question_id`, `option_id`, `answer_text`,
`organization_id`, `company_id`, `created_at`.

The shape rule is a check, not prose: an essay carries text and no option; a quiz
or a poll carries an option and no text. `0041` already denormalises `kind` onto
`promotion_question_options` so a child can prove kind and Station in one foreign
key, and the same trick applies here.

One answer per question per participation — a plain unique on
`(participation_id, question_id)`.

### 3.4 `promotions` gains one column

```sql
alter table promotions add column max_entries_per_member integer;
```

With a check that ties it to the field it depends on: filled only when
`allow_multiple_entries` is true, and at least 2 when filled — a ceiling of one
is what `allow_multiple_entries = false` already says, and two ways to say one
thing is one way too many.

### 3.5 The "one per person" index, and the reason it is not straightforward

The v1 design asks for a partial unique index when the promotion does not allow
repeats. That cannot be written directly: `allow_multiple_entries` lives on
`promotions`, and an index on `participations` cannot see another table.

The way through is the one 4a already used for the quiz — denormalise the flag
and prove it with a composite key:

```sql
alter table promotions
  add constraint promotions_id_multiple_unique unique (id, allow_multiple_entries);

-- on participations:
allows_multiple boolean not null,
foreign key (promotion_id, allows_multiple)
  references promotions (id, allow_multiple_entries) on update cascade

create unique index participations_one_per_member
  on participations (promotion_id, member_id)
  where status = 'VALID' and not allows_multiple;
```

`on update cascade` is what earns this its keep. Turning "allows repeats" off on
a promotion where one person already has two valid participations cascades the
new value onto them and the index refuses the whole update — the operator is
stopped rather than left with a promotion whose stated rule its own data breaks.
That is the exact shape of `0041`'s "a quiz with a right answer cannot become a
poll", and it is why the flag is denormalised rather than merely read.

---

## 4. N3 — the lock

The rules are checked and the row is written inside one transaction, under
`pg_advisory_xact_lock` over the pair `(promotion_id, member_id)`.

**Why not a row lock.** `SELECT ... FOR UPDATE` on the promotion would serialise
every participation in that promotion against every other — tolerable for an
operator typing one at a time, and ruinous the moment Block 5's bot is receiving
messages. Locking the participation rows for that pair locks nothing at all the
first time somebody enters, which is precisely the case the rule exists to
govern; 4b hit the identical problem when `archive_prize` needed to lock a
balance row that did not exist yet, and its comment says so.

An advisory lock has neither problem: it names the pair directly and needs no
row to exist.

**The cost, stated.** The pair is hashed into a `bigint`, so two different pairs
can collide and serialise against each other for no reason. That makes a
collision slow, never wrong — and the alternative shapes are wrong under exactly
the load Block 5 brings.

The unique index in §3.5 is the second line of defence: it holds whether or not
the function took the lock, which is what makes the mutation test in §7
meaningful.

---

## 5. RPCs and permissions

| RPC | Does |
| --- | --- |
| `resolve_or_create_member(p_company_id, p_full_name, p_phone, p_cpf_hash, …)` | Returns the listener's id, finding them through Block 3's deduplication or registering them. Thin: `find_member_by_identifier` (`0033`) then `create_member` (`0034`) |

`find_member_by_identifier` answers one of three things, and all three need a
destination here. `visible` gives the id and the participation proceeds.
`none` means register the listener and proceed. **`elsewhere` means an
identifier in the row matches somebody this caller is not allowed to reach** —
the function returns no id on purpose, and registering anyway is impossible
because `0031`'s per-Organization unique indexes on phone, e-mail, CPF and
passport would refuse the duplicate. That row is skipped and reported, alongside
the unreadable ones. It is the one skip reason that is not a defect in the file.

| `record_participation(p_promotion_id, p_member_id, p_participated_at, p_answers)` | Takes the lock, applies the rules, writes the participation and its answers with the resulting status |
| `import_participations(p_promotion_id, p_rows)` | One call per file; per row, `resolve_or_create_member` then what `record_participation` does |
| `remove_promotion_question` (recreated) | 4a's function, now refusing while the promotion has any participation |
| `update_promotion` (recreated) | 4a's function, now freezing the hashtag and the start date once a participation exists |

`record_participation` takes a listener who has already been resolved, and both
doors resolve the same way: the manual form calls `resolve_or_create_member`
unless the operator picked somebody from the search box, and the import calls it
per row. Giving `record_participation` two modes — an id or a set of identifying
fields — would be the same rule with two entrances, which is the shape 4b was
sent back to fix twice.

The two recreated functions are 4a's D9 coming due. Both are `create or replace`
with unchanged signatures, so neither has 4b's drop-and-recreate hazard — but
`02_permissions.test.sql` pins their grant grid, and 4b learned the hard way that
`::regprocedure` proves a signature exists and nothing about what else shares the
name. The plan carries that forward.

**New module: `participations.view`, `participations.create`,
`participations.import`.** Its own module rather than more `promotions.*` codes,
because participations get their own screen, and every screen-level module in
this project owns its codes. Import additionally requires `members.create` (D10).

**Refusals that are part of the contract**, each with an isolation case: entering
into a cancelled or archived promotion; entering before the promotion opens or
after it closes; a listener from another Station; an answer naming a question
that belongs to a different promotion; an answer naming an option that belongs to
a different question; a non-existent promotion.

Note which refusals are **not** in that list. Repeating, coming in too early and
passing the ceiling are not refusals at all — they are written down with the
status that says what happened (D5).

---

## 6. Screens

**`/participations`** — keyset pagination, the Block 3b shape: filter by
promotion, by status, by source and by date; search by listener. The default
filter is `VALID`, because that is the question being asked almost every time,
and the filter is visible so nobody concludes the refused ones were lost.

**The promotion record's fifth tab** — the count, split valid against refused,
the Lançar and Importar buttons, and a link into the screen above filtered to
this promotion. Fixed cost regardless of size, which is what lets the record go
on being read once per opening.

**Import** takes a CSV — UTF-8, comma-separated, one header row naming the four
columns of D7 in any order. It is a file picker, a confirmation of how the
header mapped, and a result: how
many entered, how many were written down as refused and why, how many rows were
skipped as unreadable with their line numbers, and how many listeners were
created. A promotion that draws only among correct answers warns before it
writes (D7).

The audience screen gains nothing here. "Which promotions has this listener
entered" is a fair question and it is not this block's.

---

## 7. Verification

Every gate at real defaults.

**pgTAP** for each constraint: the two composite foreign keys refusing a
cross-Station promotion and a listener the Station is not linked to; the answer
shape check both ways; one answer per question; `max_entries_per_member`
refusing a value without `allow_multiple_entries` and refusing 1; and the partial
unique index refusing a second valid entry while allowing a refused one beside it.

**Isolation**, under a non-owner delegate, for every refusal in §5 and every
status in §3.2, plus the three that matter most:

- **Concurrency (N3).** Two `record_participation` calls for the same pair, at
  once, against a promotion that does not allow repeats: exactly one is `VALID`
  and the other is `DUPLICATE`. This is the case the whole section exists for.
- **4a's D9.** With a participation on the promotion: `update_promotion` refuses
  to change the hashtag or the start date and still accepts the name and the end
  date; `remove_promotion_question` refuses outright.
- **Import.** A file mixing good rows, repeat rows and unreadable rows produces
  exactly the three outcomes, and the listener count matches what was created.

**Mutation, planned in advance:** remove the advisory lock and the concurrency
case must go red — if it stays green because the unique index caught it, the
case is testing the index rather than the lock and has to name the status, not
just the count. Remove the participation check from `update_promotion` and the
D9 case must go red. Both are assertions that would otherwise pass while the
thing they guard was gone.

---

## 8. Deliberately out of this pass

- **The bot.** Block 5 adds `WHATSAPP` to `source` and a webhook; nothing here
  reads a message.
- **The draw.** Block 6 consumes `require_correct_answer` and `status = 'VALID'`.
  4c stores what makes both computable and computes neither.
- **Withdrawing a participation.** There is no delete and no soft delete. If an
  operator enters the wrong listener, Block 6's draw is where the consequence
  shows, and the fix belongs with whatever decides that.

---

## 9. Open

- **Whether `participations.*` should be its own module** (§5), or three more
  `promotions.*` codes — the owner's call at review, exactly as with 4a's five
  and 4b's one.
- ~~What the import does about a row matching two different people.~~
  **Not open — Block 3 settled it, and 4c follows rather than re-decides.**
  `find_member_by_identifier` (`0033`) already handles the split-identifier case:
  it collects every candidate any supplied identifier matches and picks
  deterministically — the reachable one first, then the lowest id — and the
  function's own comment records that resolving per-identifier, so the caller
  learns which field collided, was **deliberately rejected by the owner**. This
  spec proposed skipping such a row as unreadable, which would have been a second
  answer to a settled question. Withdrawn.
- **The audience screen still cannot answer "which promotions has this listener
  entered"** (§6).
