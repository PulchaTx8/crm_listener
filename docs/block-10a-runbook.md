# Block 10a — Audit Viewer and WhatsApp Integrations

**Audience:** whoever deploys this block, whoever connects a radio to WhatsApp,
and whoever is asked "who did this, and when".

---

## 0. Deploy

Ordinary, and worth saying explicitly because the previous block's was not.
Nothing here rewrites a shared function; `0129` and `0130` add two new
functions and change nothing that exists.

1. `supabase db push` (`0129`, `0130`).
2. `npm run db:test` — 1358/1358.
3. The frontend.

**If the frontend goes first:** both screens render and fail behind them with
`PGRST202` ("Could not find the function `public.list_audit_logs` in the schema
cache"). Loud, and it names no migration — which is the usual shape of this
mistake in this codebase.

---

## 1. Connecting a Station to WhatsApp

**`/admin/integrations` is now the only supported way.** Before this block it
was SQL by hand against production; that path still works and should not be
used, because it writes no `audit_logs` row and the screen is where the record
of who changed a number now lives.

Platform administrators only. The screen lists **every Station**, connected or
not, so a new radio is found by looking rather than by knowing its id.

### The three credentials stay environment variables

`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_ACCESS_TOKEN` are
installation-wide: **one Meta app serves every Station.** The screen shows
whether each is set and never its value.

**Until all three are set, no Station sends or receives anything**, however it
is configured — the panel at the top of the screen says so, and that is the
first thing to check when a radio is silent.

### What a Station carries

`phone_number_id` (required), `waba_id`, a display number, and an enabled flag.

**A phone number id can belong to exactly one Station.** This is a correctness
constraint and not hygiene: the webhook routes an inbound message by
`phone_number_id`, so a number claimed twice would silently deliver a listener's
message to the wrong radio. The screen refuses with "That phone number id
already belongs to another Station".

### Disabling

**Disabling does not release the number.** The row stays live, so the number
stays claimed by that Station. "This radio is not sending right now" and "this
number is free for another radio" are different statements, and only the first
is what disabling means. To move a number between Stations, change it on the
Station that holds it first.

---

## 2. Reading the audit trail

`/audit`, in the app, for anybody holding **`audit.view`** in the Organization.

### What you see is what you may read

There is no permission gate on the page and none in the listing function. The
trail is filtered by `audit_logs`' own policies:

- a **platform admin** sees everything, including rows belonging to no customer;
- a **member with `audit.view`** sees their Organization's rows;
- **anybody else sees an empty page** — not an error, and the screen says why.

So "the audit trail is empty" from a member who expected rows is almost always a
missing `audit.view` on their role, not a missing trail.

### The columns that mislead if read alone

**`actor_name` being blank does not mean the system did it.** It is
`profiles.full_name`, which is nullable — a real operator who never set a
display name has a blank name too. The viewer shows `(system)` **only** when
there is no actor id at all, which is what a `pg_cron` sweep leaves.

**`detail` is never summarised.** It is the raw `jsonb` the writing code
recorded, behind a "show" toggle. Forty call sites across nine blocks wrote into
that column with different shapes; anything that summarised it would be showing
you an interpretation at the moment you most need the record.

**An action code you do not recognise renders as the code itself.** That is
deliberate: a later block adds a code, nobody updates the label table, and you
see `winners.reopen_deadline` rather than a blank cell.

### Filters are URLs

Every filter is a query parameter, so a filtered view is a link. Paste it into a
ticket — that is the intended way to say "here is what happened".

### What is not here

**No export.** Exporting an audit trail is itself an audited event, and that
recursion is a decision nobody has made yet. Block 11 owns it, alongside how long
the trail is kept — **which today is for ever**. There is no retention sweep on
`audit_logs`.
