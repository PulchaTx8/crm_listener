# Block 5b — The conversation — Runbook

A separate file rather than sections folded into `docs/block-5a-runbook.md`, and
the reason is that the two answer different questions. The 5a runbook is how you
**switch the bot on**: the Meta app, the webhook URL, the credentials, the cron
job. Everything below assumes that is already done and is about how the bot now
**behaves** — what it asks, how long it waits, where the answers land. Folding
them together would have buried the setup steps somebody follows once inside
operating notes they come back to.

Read 5a's first if the bot is not receiving messages at all.

---

## 1. The change every existing promotion sees on deploy

**A hashtag no longer enters anybody.** It opens a conversation.

Before this block, one message was one entry: the listener sent `#EUQUERO` and
was in. Now that message gets a reply asking them to confirm, with two buttons,
and they are entered only when they press **Quero!** and answer whatever the
promotion asks for.

So **every promotion that exists today takes at least two messages instead of
one**, and nobody has to change anything for that to happen — it is true the
moment this deploys. Tell the Stations before they hear it from a listener.

What it buys, and why the owner asked for it: somebody can now say **no**, and
that no is recorded rather than looking like an abandonment.

---

## 2. `data_validity_months` — how fresh a listener's data must be

A new field on the promotion, beside the "Solicitar Dados Pessoais" checkboxes.
It answers a different question from the checkboxes: they say **which** fields
to ask for, this says **how old** an answer may be and still count.

| Value | What the bot does |
|---|---|
| *(blank)* | Never re-asks a field the record already holds, at any age. |
| `3` | Accepts a field confirmed in the last three months; asks again if it is older. |
| `0` | Asks every requested field every time. |

An **empty** field is always asked, whatever this says — there is nothing to be
fresh about.

**Per field, not per record**, and that is the part worth understanding: the
record remembers when each field was last confirmed, separately. A listener who
enters weekly through promotions that ask only for "cidade" keeps a fresh city
and an ageing address, and the address gets asked when a promotion cares about
it. A single date per record would have been refreshed by every conversation and
the address would never have been asked again.

**What counts as a confirmation:**

- the listener answering the bot;
- an operator typing the value on the record screen — but only for the fields
  whose value actually **changed** in that save. Retyping a value identically is
  not confirming it, and opening a record and saving it unchanged confirms
  nothing;
- clearing a field to blank **removes** its confirmation.

---

## 3. The thirty-minute window

A conversation lives for **thirty minutes of silence**. Any message inside that
continues where it stopped; the timer restarts on every message.

After thirty minutes the conversation is discarded and the listener is a
stranger again: their next message gets **silence**, and the next hashtag they
send starts from the beginning. Nothing they had already answered is kept —
an unfinished conversation writes nothing to the record and creates no entry.
That is deliberate: half a confirmation is not a confirmation.

**Three wrong answers at one step** get a re-prompt each; the fourth ends the
conversation with a message. The counter resets whenever a step is answered, so
a long conversation is not ended by three mistakes spread across it.

---

## 4. Turning Redis on, and telling which store is live

Conversations live in Postgres by default. Nothing needs installing and nothing
needs configuring.

To use Redis instead, set **`REDIS_URL`** (for example
`redis://10.0.0.5:6379`) and restart the app. That is the whole switch.

**How to tell which one is live:**

- Set and reachable → Redis. `KEYS 'conv:*'` on the Redis instance lists live
  conversations, one key per `(integration, phone)`.
- Unset → Postgres. `select count(*) from whatsapp_conversations;` counts them.
- Set but **unreachable** → Postgres, and the tick logs
  `REDIS_URL is set but unreachable, falling back to the Postgres store`. The bot
  keeps working. Grep the container logs for that line before assuming Redis is
  in use.

Conversations do not migrate between stores. Switching mid-flight leaves the
ones in the other store to expire on their own — the listeners affected send
their hashtag again, and there is nothing to clean up.

The lock that stops two of a listener's messages being processed at once stays
in Postgres either way (`whatsapp_conversation_leases`). Do not expect to find
it in Redis.

---

## 5. Telling a refusal from an abandonment

Two different things, and the difference matters for how a Station follows up:

```sql
-- Somebody who pressed "Agora não". They saw the promotion and declined.
select count(*) from public.promotion_refusals where promotion_id = '…';

-- Somebody who was asked and never came back: no refusal row, no
-- participation, and the conversation gone. There is no row for this by
-- design -- an abandonment is an absence, and inventing a row for it would
-- mean writing down every listener who read a message and put the phone down.
```

A refusal is **not** a participation and carries no `participation_status`: the
draw's "VALID only" filter would otherwise look complete while hiding a
different kind of fact. Repeat refusals accumulate — how often somebody declines
is the measurement the table exists for.

---

## 6. Diagnosing a conversation that seems stuck

In order, because each step rules out the one below it:

1. **Did the message arrive?**
   `select status, outcome, received_at from webhook_events order by received_at desc limit 20;`
   Nothing recent means the webhook is not reaching us — 5a's runbook.
2. **Is it still `PROCESSING`?** Normal for a second or two. Older than five
   minutes means a worker died mid-turn; the reclaim frees it on the next tick
   and it is re-run. Nothing to do by hand.
3. **`outcome = 'no_conversation'`** means the message arrived from somebody who
   was not mid-conversation and whose message opened none — an answer that came
   after the window closed, or a stranger saying hello. Silence is correct.
4. **Is there a live conversation?**
   `select phone, state ->> 'cursor' as step, expires_at from whatsapp_conversations;`
   (or `GET conv:<integration>:<phone>` on Redis).
5. **Did the reply go out?**
   `select status, attempts, last_error from outbox_messages order by created_at desc limit 20;`
   A row stuck `PENDING` with attempts climbing is a send failing — the `body`
   column shows what the listener was going to be told, whether or not the
   message was interactive.

**A lease that will not clear.** `whatsapp_conversation_leases` holds one row per
phone mid-turn. A row older than five minutes is taken over automatically by the
next message from that phone, and the sweep deletes anything older than an hour.
There is no reason to delete one by hand; if you do, do it while nothing is
running for that phone.
