# Block Templates — A Station's own words, and the message it may send first

**Audience:** whoever operates a Station, and whoever gets asked "why is the
bot still saying the old text?" or "why did the winner never get a reminder?"

Two things arrive with this block. The bot's own sentences — the ten it says
without being asked — stop being the same for every Station and become
something each one can rewrite for itself. And a Station gains the one thing
WhatsApp requires before it may *start* a conversation: a template Meta has
approved, recorded here.

---

## 0. Read this first: the two-deploy trap

**`has_permission` refuses a permission code that is not in
`public.permissions`.** It does not fail loudly; it answers `false`. The codes
this block introduces — `templates.view` and `templates.manage` — are inserted
by migration `0109`, so until that migration is applied to the database the
application is talking about:

- both new screens redirect every caller — including an Organization owner —
  straight back to `/app`,
- every role editor shows no Templates permissions to grant,
- and nothing anywhere says why.

**Deploy the migrations before, or at the same time as, the application.** If
the code is already live and the screens redirect for everyone, the diagnosis
is one query:

```sql
select code from public.permissions where module = 'templates';
```

Two rows (`templates.view`, `templates.manage`) means the database is ready.
No rows means the migrations have not been applied — go to §1.

---

## 1. Applying the migrations

```bash
supabase db push        # hosted
# or, locally
npx supabase db reset
```

Six migrations belong to this block:

| migration | what it adds |
|---|---|
| `0109_station_message_templates.sql` | the copy-override table, its ten-value key enum, and the two permission codes |
| `0110_message_templates.sql` | the approved-template registry |
| `0111_outbox_template.sql` | three outbox columns, `claim_outbox_batch`'s third definition, `enqueue_whatsapp_outbound` recreated with template resolution |
| `0112_sweep_pickup_reminders.sql` | `enqueue_pickup_reminder`, the hourly sweep, and its `pg_cron` schedule |
| `0113_template_doors.sql` | the four write doors both screens call |
| `0114_prompt_context_overrides.sql` | the two context builders start reading a Station's overrides |

**`0111` and `0113` are not re-runnable against an already-migrated database**
in the way `0112`'s schedule is. `0111` drops and re-creates two functions,
`0113` creates four new ones with `create function` rather than `create or
replace`. This is the ordinary Supabase migration contract — each file runs
once, in order — and only matters if somebody tries to replay one by hand.

Confirm the schedule landed:

```sql
select jobname, schedule, command
from cron.job
where jobname = 'pickup-reminder-sweep';
```

One row, `0 * * * *`, calling `public.sweep_pickup_reminders()`. No row means
`0112` has not been applied, or something has since called
`cron.unschedule('pickup-reminder-sweep')`.

---

## 2. Which permission unlocks what

```sql
select code, module, label from public.permissions where module = 'templates' order by display_order;
```

| code | label | what it opens |
|---|---|---|
| `templates.view` | See the message templates | both screens, read-only |
| `templates.manage` | Edit the message templates | every form and button on both screens |

Two codes, not three. Nothing in this block destroys the way a merge does:
removing an override returns a text to a default the code still holds, and
removing a registration loses nothing Meta is not still holding a copy of. An
Organization's owner holds both automatically (the owner bypass in `0024`);
anybody else needs them granted through a role, on **Organization → Roles**.

---

## 3. Where it lives

A new **Templates** section in the sidebar, between Music and Organization,
with two items. The section is visible to every member — opening either page
without `templates.view` at the selected Station redirects away, and the
database re-checks underneath regardless. A visible link is a courtesy; the
boundary is in the database.

**Templates → Messages**, or `/templates/messages` — the ten sentences the bot
says on its own initiative inside a conversation: the two standalone messages
(declining an invitation, giving up after three unusable answers) and the eight
field prompts (name, address, city, neighbourhood, date of birth, CPF,
passport, how they found the Station).

**Templates → WhatsApp**, or `/templates/whatsapp` — the templates Meta has
approved for this Station, recorded so the system can send them.

---

## 4. Giving a Station its own wording

Open **Templates → Messages**, pick the Station, edit any of the ten boxes,
press **Save**.

Three things about this screen that are not obvious and are all deliberate:

**The ten bodies are in Portuguese, and must stay that way.** They are the only
strings in this product a *listener* reads. Everything around them — the
labels, the buttons, this runbook — is English because it is read by an
operator. Translating a body into English does not break anything the system
can detect; it just means every listener at that Station gets an English
message from then on.

**A text you have not changed is not stored anywhere.** There is no row until
you save one. That is why a brand-new Station already speaks, with no setup
step and no seeding — and why the bot cannot be made to go silent by clearing
something.

**"Restore the default" is its own button.** Emptying the box and saving does
not clear an override; it is refused, in three separate places, on purpose.
Saving an empty box is a mistake somebody makes at 2am; restoring a default is
a decision. Only the button expresses the second one.

Changes take effect on the **next message** — there is no deploy, no cache and
no restart. A conversation already underway picks the new wording up at its
next turn.

---

## 5. The pickup reminder, end to end

This is the part that takes days, and the delay is not in this system.

### 5.1 Why a template at all

A pickup reminder goes out *days* after the draw that produced it, on the
Station's initiative. WhatsApp only allows a business to open a conversation
that way with a template Meta has approved in advance. An ordinary text send —
everything else this system does — is a *reply*, allowed only inside the
24 hours after the listener last wrote. That is the whole reason this block
exists.

### 5.2 Create the template in Meta's console

**In the WhatsApp Manager for this Station's WABA, not here.** This system
records approvals; it does not request them (and cannot: the screen has no
route to Meta at all).

The body must use exactly **three** placeholders, in this order — this is what
the system will actually substitute, positionally:

| position | what this system puts there |
|---|---|
| `{{1}}` | the winner's **first name** |
| `{{2}}` | the **prize name** |
| `{{3}}` | the **deadline as a date**, `DD/MM/YYYY`, in the Station's own timezone |

A working shape, in Portuguese:

> `Oi {{1}}! Seu prêmio {{2}} está te esperando aqui na rádio. Você tem até {{3}} para retirar.`

A body meaning something else by `{{2}}` will send a prize name where a date
belongs and **nothing in this system can detect that** — the count still
agrees, so every check passes and the listener reads nonsense. The order is the
contract; the WhatsApp screen prints it beside the form for exactly this
reason.

### 5.3 Wait for approval

**No reminder can go out until Meta approves the template.** Approval
routinely takes days and is entirely outside this product — there is no step
here that makes it faster, and no screen that shows its progress. An operator
who does not know this reads the silence as a bug in the CRM.

### 5.4 Record the approval

Open **Templates → WhatsApp**, pick the Station, and transcribe from the
console **exactly**:

- **Name at Meta** — the template's name as approved, e.g. `pickup_reminder`.
- **Language** — the approved language code, e.g. `pt_BR`. A template approved
  in `pt_BR` cannot be sent as `pt`.
- **Approved body** — copied character for character, placeholders included.
  The screen counts the `{{n}}` as you type and asks for a short description of
  each; if the count is not three it says so, in red, before you save.

Press **Record this template**. The card's badge changes from "Not registered —
nothing sends" to "Registered".

One registration per purpose per Station. Recording again replaces what is
there; there is no separate edit.

### 5.5 Watch one go out

The sweep runs hourly, on `pg_cron`. It picks up every winner who is
`AWAITING_PICKUP`, whose draw was not cancelled, and whose deadline is **in the
future and within the next two days**.

```sql
-- what the sweep enqueued
select created_at, status, template_name, template_language, body
from public.outbox_messages
where dedupe_key like 'pickup-reminder:%'
order by created_at desc
limit 20;
```

`body` is the approved text with the three values already substituted — what
the listener actually reads, kept on the row so "what were they told?" stays
answerable after the phone is pruned.

Then the ordinary WhatsApp worker tick claims it and sends it, on its usual
ten-second cadence. A `SENT` status means Meta accepted it.

### 5.6 When nothing goes out

The sweep never aborts a batch: one Station's failure is logged and the walk
continues. Every failure names its winner in a server-log `WARNING`:

```
pickup reminder sweep failed for winner <uuid>: <reason>
```

| what the log says | what it means |
|---|---|
| `no approved template registered for PICKUP_REMINDER in this station` | §5.4 has not been done for that Station. Expected, routinely, and not an error. |
| `template ... expects N variable(s), got 3` | the registered body does not use three placeholders — re-read §5.2 and re-record it |
| a Station with no enabled WhatsApp integration | Block 5a's setup was never completed there |
| a listener with no phone on file | nothing to send to |

**A revoked approval is not visible from this system.** What the WhatsApp
screen shows is what somebody transcribed when they registered it — there is no
`status` column and deliberately so, because a status recorded here would look
like live truth and be a memory. If Meta revokes or edits an approval, the
first *refused send* is what discovers it: the outbox row is parked with Meta's
own reason on it.

```sql
select last_error, attempts, status
from public.outbox_messages
where dedupe_key like 'pickup-reminder:%' and status = 'FAILED'
order by updated_at desc;
```

---

## 6. What this block did not build

Four things the legacy screen had, and one screen the 2026-08-03 decision
named, are deliberately absent: an inactivity message, a "please wait"
message, an audio rejection, a call rejection, and the Interaction Templates
screen. None is an oversight; each is priced in
`docs/block-templates-report.md` §4 and §5 so the owner can decide whether to
buy it.
