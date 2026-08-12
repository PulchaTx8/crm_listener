# Block 19a — WhatsApp as a door into the widget: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A listener sends a hashtag to a Station's WhatsApp number and receives one message carrying a link that opens the widget already identified — straight into the music panel, into a named promotion, or on the menu.

**Architecture:** Three migrations (the two hashtag columns and their door; the single-use link table and its two doors; the rewritten `ingest_whatsapp_event`), a pure TypeScript module that builds the URL and the message, one new branch in the worker's turn handler, one route handler that trades a code for the widget session, and two fields on `/templates/messages`. The service itself is not touched: it is the widget, unchanged.

**Tech Stack:** Next.js 15 App Router (route handlers, server actions), Supabase Postgres 17, pgTAP, Vitest, Playwright, next-intl, Zod.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-11-whatsapp-service-entry-design.md`. D1–D8 live there; §11 says this plan is 19a and stops before the application shell.
- **Migrations are `0177`, `0178` and `0179`.** The repository is at `0176`. Confirm with `ls supabase/migrations | tail -3`.
- **Never retype a shipped function body.** `ingest_whatsapp_event` is defined in `0062` and REPLACED in `0070`; the live body is 0070's. Extract it by script (Task 3, Step 1) and edit the extract. This is how 0168 silently reverted 0163's public-key pin.
- **Message catalogues are `messages/{en,pt,es}.json`, CRLF.** Edit by `JSON.parse` → mutate → `(JSON.stringify(o, null, 2) + '\n').replace(/\n/g, '\r\n')`.
- **Listener-facing copy is Portuguese; everything else is English** — identifiers, comments, commits, operator strings.
- **`readSessionFor`, never `readSession`,** in anything the widget serves.
- **`npm run db:test` needs a freshly reset database**, and `npm run db:reset` leaves Kong with a stale auth upstream: reset → `docker restart supabase_kong_CRM_-_LISTENER` → wait ~10s → run. Without it every e2e spec fails at once with `could not create admin: {}`.
- **The deploy does not carry migrations.** Apply on merge (four occurrences: 13a, 17b, 17c, and 18's own near miss).

---

## File Structure

| file | responsibility |
| --- | --- |
| `supabase/migrations/0177_service_hashtags.sql` | `widget_installations.music_hashtag`/`.service_hashtag`, `set_service_hashtags` |
| `supabase/migrations/0178_widget_link_tokens.sql` | the table, `mint_widget_link`, `consume_widget_link` |
| `supabase/migrations/0179_ingest_link_intent.sql` | `ingest_whatsapp_event` rewritten around D3 and D7 |
| `supabase/tests/44_service_hashtags.test.sql` | pgTAP for 0177 and 0179's matching |
| `supabase/tests/45_widget_link_tokens.test.sql` | pgTAP for 0178, including the race and the window |
| `src/lib/widget/service-link.ts` | pure: the URL a code becomes, and the message body it travels in |
| `src/services/whatsapp-link.ts` | mint + enqueue + finish, called from the worker |
| `src/services/conversation.ts` | one new branch: a link intent, and the live conversation that outranks it |
| `src/app/(widget)/w/[publicKey]/enter/route.ts` | trades the code for the session cookie, then redirects |
| `src/lib/widget/session.ts` | `WidgetClaims.channel` |
| `src/app/(app)/templates/messages/hashtag-fields.tsx` | the two fields |
| `src/app/(app)/templates/messages/actions.ts` | `saveServiceHashtagsAction` |
| `src/services/templates.ts` | `getServiceHashtags`, `setServiceHashtags` |

---

### Task 1: The two hashtags, and the door that writes them

**Files:**
- Create: `supabase/migrations/0177_service_hashtags.sql`, `supabase/tests/44_service_hashtags.test.sql`

**Interfaces:**
- Consumes: `widget_installations` (0159), `has_permission` (0024), `promotions.hashtag` (0040).
- Produces: `public.set_service_hashtags(p_company_id uuid, p_music text, p_service text) returns void`; columns `widget_installations.music_hashtag` and `.service_hashtag`.

- [ ] **Step 1: Confirm the number**

Run: `ls supabase/migrations | tail -3`. Expected: highest is `0176_widget_show_choice.sql`.

- [ ] **Step 2: Write the failing pgTAP**

Create `supabase/tests/44_service_hashtags.test.sql` with `select plan(9)`. Fixtures follow `39_widget_installations.test.sql`: one Organization, one Station, one installation, one member holding `templates.manage` at that Station, and a second Station for the tenancy assertion.

The nine assertions:

1. `set_service_hashtags` writes both columns.
2. A caller without `templates.manage` is refused (42501).
3. A hashtag not matching `^#[^[:space:]#]{1,39}$` is refused (22023).
4. The two hashtags being equal, ignoring case, is refused (22023).
5. A hashtag equal to a LIVE promotion's hashtag at that Station is refused (22023).
6. …and the comparison ignores case (`#Euquero` vs a stored `#EUQUERO`).
7. A hashtag equal to a promotion's at ANOTHER Station is accepted — a hashtag belongs to a Station.
8. `null` clears a column, and clearing is not a collision with itself.
9. A Station with no installation is refused with P0002, not a silent no-op.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx supabase test db supabase/tests/44_service_hashtags.test.sql --local`
Expected: FAIL — `function public.set_service_hashtags(uuid, text, text) does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- supabase/migrations/0177_service_hashtags.sql

-- Block 19a (D6). The two hashtags a Station answers with a link.
--
-- ON widget_installations, not on integrations and not on companies, because
-- this row IS the Station's service configuration: it already holds the public
-- key the link points at, the interval between music requests, and the switch.
-- A hashtag that opens the widget belongs beside the widget it opens.
--
-- NULL IS THE CLOSED DOOR, and it is the state every Station starts in. An
-- empty string is not a second way to say the same thing: the CHECK below
-- refuses it, because '' would match nothing and read on screen as configured.

alter table public.widget_installations
  add column music_hashtag   text,
  add column service_hashtag text;

alter table public.widget_installations
  add constraint widget_installations_hashtag_shape check (
    (music_hashtag   is null or music_hashtag   ~ '^#[^[:space:]#]{1,39}$') and
    (service_hashtag is null or service_hashtag ~ '^#[^[:space:]#]{1,39}$')
  );

-- The same grammar promotions_hashtag_shape (0040) states, and stated again
-- rather than shared: a CHECK cannot reference another table's constraint, and
-- two grammars for one idea is how "#EU QUERO" becomes storable in one screen
-- and unmatched by the other.
alter table public.widget_installations
  add constraint widget_installations_hashtags_differ check (
    music_hashtag is null
    or service_hashtag is null
    or lower(music_hashtag) <> lower(service_hashtag)
  );

comment on column public.widget_installations.music_hashtag is
  'Block 19a. The hashtag that answers with a link straight into the music panel. NULL means this Station has not opened that door -- the ordinary state, and never an error. Matched case-insensitively against the first hashtag of an inbound message, AFTER the Station''s live promotions (D3).';

comment on column public.widget_installations.service_hashtag is
  'Block 19a. The hashtag that answers with a link to the widget menu, where the listener chooses between a song and a promotion. NULL means closed. Matched last of the three (D3).';

create function public.set_service_hashtags(
  p_company_id uuid,
  p_music      text,
  p_service    text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_music   text := nullif(btrim(coalesce(p_music, '')), '');
  v_service text := nullif(btrim(coalesce(p_service, '')), '');
  v_clash   text;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'set_service_hashtags denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- A LIVE PROMOTION'S HASHTAG WINS THE MATCH (D3), so a Station hashtag equal
  -- to one would never answer and no screen would say why. Refused at write
  -- time, which is the only moment somebody is looking.
  --
  -- Scoped to this Station: a hashtag belongs to a Station, and the same tag at
  -- a sister Station is a different Station's word.
  -- ENDED PROMOTIONS DO NOT CLASH, and the window is the whole of the rule.
  -- ingest_whatsapp_event matches a promotion only inside `starts_at`..`ends_at`,
  -- so a Station hashtag equal to a promotion that finished last year is never
  -- shadowed by it and refusing it would forbid reusing the word for ever --
  -- which is exactly what 0040 weighed and rejected for promotion-vs-promotion
  -- ("it would forbid reusing #EUQUERO next year").
  --
  -- A promotion that has not STARTED yet does clash: the day it opens it takes
  -- the tag, and the Station's own hashtag would go quiet with nothing on any
  -- screen to say why. So the predicate is `ends_at > now()` -- live now, or
  -- live later.
  select p.hashtag into v_clash
    from public.promotions p
   where p.company_id = p_company_id
     and p.hashtag is not null
     and p.deleted_at is null
     and p.cancelled_at is null
     and p.ends_at > now()
     and lower(p.hashtag) in (lower(coalesce(v_music, '')), lower(coalesce(v_service, '')))
   limit 1;

  if v_clash is not null then
    raise exception 'the hashtag % already belongs to a promotion of this Station', v_clash
      using errcode = '22023';
  end if;

  update public.widget_installations
     set music_hashtag   = v_music,
         service_hashtag = v_service,
         updated_at      = now()
   where company_id = p_company_id
     and deleted_at is null;

  if not found then
    raise exception 'this Station has no widget installation' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.set_service_hashtags is
  'Block 19a (D6). Writes the Station''s two service hashtags, checking templates.manage -- the permission the screen that edits them is gated on, even though the row belongs to the console. That mismatch is deliberate and the spec''s section 5 carries the reasoning: a third permission for two text fields is the mistake Block 18 documented at length. Refuses a hashtag a live promotion already owns at this Station, because D3 matches promotions first and the Station''s would silently never answer. NULL clears. A Station with no installation is refused rather than silently written to nothing: creating an installation is a console act (0159).';

revoke execute on function public.set_service_hashtags(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_service_hashtags(uuid, text, text) to authenticated;
```

- [ ] **Step 5: Run until green**

Run: `npm run db:reset && npx supabase test db supabase/tests/44_service_hashtags.test.sql --local`
Expected: 9 of 9.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0177_service_hashtags.sql supabase/tests/44_service_hashtags.test.sql
git commit -m "feat(19a): the two hashtags a Station answers with a link"
```

---

### Task 2: The single-use link

**Files:**
- Create: `supabase/migrations/0178_widget_link_tokens.sql`, `supabase/tests/45_widget_link_tokens.test.sql`

**Interfaces:**
- Produces:
  - `public.mint_widget_link(p_company_id uuid, p_member_id uuid, p_purpose public.widget_link_purpose, p_promotion_id uuid default null) returns text` — returns the RAW code
  - `public.consume_widget_link(p_code text) returns jsonb` — `{ok, public_key, company_id, organization_id, member_id, purpose, promotion_id}` or `{ok:false, reason}`
  - `public.widget_link_purpose` enum: `MUSIC`, `MENU`, `PROMOTION`

**The two-minute window is D2.** A hashtag repeated returns the code already minted for that listener, purpose and promotion — one answer, one working link.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/45_widget_link_tokens.test.sql`. The list below is ten
facts; the file ends at `plan(12)` because two of them split into a pair:

1. `mint_widget_link` returns a code, and the row stores only its SHA-256 (the raw code appears nowhere in the table).
2. Minting twice inside two minutes returns **NULL** the second time — the raw code is unrecoverable by design, so the window says "already answered, send nothing" rather than repeating itself.
3. …only when the purpose matches: `MUSIC` then `MENU` returns two different codes.
4. …and only when the promotion matches: two different `PROMOTION` codes for two promotions.
5. Minting after the window (backdate `created_at` ONLY, leaving the old row unexpired) returns a **fresh** code — and, beside it, the still-live older code **can still be consumed**, because nothing invalidates a token early. Backdating `expires_at` too would let the expiry clause do the excluding and leave the window itself untested.
6. `consume_widget_link` returns the claims and marks the row.
7. A second consume of the same code refuses with `unusable`.
8. **Two concurrent consumes: exactly one wins.** Genuinely two sessions — `dblink` if this stack has it, and if it has not, DROP this assertion and say so in the file rather than writing a sequential test wearing the word "concurrent": that test passes against the broken select-then-update it exists to catch. Task 9's load test covers real concurrency either way.
9. An expired code refuses with `unusable`, and expiry is 15 minutes. Used, expired and unknown are ONE answer on purpose (§7 of the spec) — the caller serves a public URL and the difference would only help somebody probing.
10. A code for an installation that has been disabled since minting refuses with `unavailable`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx supabase test db supabase/tests/45_widget_link_tokens.test.sql --local`
Expected: FAIL — `type "widget_link_purpose" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0178_widget_link_tokens.sql

-- Block 19a (D2). The addressed door a hashtag is answered with.
--
-- A TABLE RATHER THAN A SIGNED STRING, and the spec's section 4 argues it: single
-- use is state -- there is nothing to burn in a token nobody wrote down -- and
-- the two-minute resend window needs the same state. The widget SESSION stays
-- signed and stateless, because it needs neither.

create type public.widget_link_purpose as enum ('MUSIC', 'MENU', 'PROMOTION');

create table public.widget_link_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  member_id       uuid not null references public.members (id),
  public_key      text not null,
  purpose         public.widget_link_purpose not null,
  promotion_id    uuid references public.promotions (id),
  -- THE HASH, never the code. The raw value exists in one WhatsApp message and
  -- in one URL, and nowhere else -- the same rule api_credentials (0133) holds,
  -- for the same reason: a table read is not a way to act as somebody.
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint widget_link_tokens_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- A promotion link names a promotion; the other two do not. Stated here so a
  -- caller cannot mint a PROMOTION link that opens the menu instead.
  constraint widget_link_tokens_purpose_shape check (
    (purpose = 'PROMOTION' and promotion_id is not null)
    or (purpose <> 'PROMOTION' and promotion_id is null)
  )
);

-- The window's lookup: this listener, this purpose, still live.
create index widget_link_tokens_window_idx
  on public.widget_link_tokens (member_id, purpose, created_at desc)
  where consumed_at is null;

alter table public.widget_link_tokens enable row level security;
revoke all on public.widget_link_tokens from anon, authenticated;

comment on table public.widget_link_tokens is
  'Block 19a. One row per link a hashtag was answered with: who it is for, what it opens, and whether it has been used. RLS on with NO POLICY and the ACL revoked -- it names a listener, so it is reachable only from inside a SECURITY DEFINER body, the rule every listener-bearing table here follows. Rows past their expiry are removed by the retention sweep (Block 11a), never by a reader.';

create function public.mint_widget_link(
  p_company_id   uuid,
  p_member_id    uuid,
  p_purpose      public.widget_link_purpose,
  p_promotion_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations%rowtype;
  v_code    text;
  v_live    text;
begin
  select * into v_install
    from public.widget_installations
   where company_id = p_company_id
     and enabled
     and deleted_at is null;

  if not found then
    raise exception 'this Station has no live widget installation' using errcode = 'P0002';
  end if;

  -- D2's window. Returning the SAME code, not a second one: an impatient
  -- listener sending the hashtag three times gets one answer and one link that
  -- works, rather than three of which only the last opens.
  --
  -- The raw code cannot be re-derived from the hash, so the window returns a
  -- code only when the caller can still produce it -- which it cannot. So the
  -- window is expressed the only way it can be: the previous row is REUSED by
  -- returning its own raw value, which means the raw value has to survive the
  -- call. It does not. Therefore the window is implemented as "do not mint a
  -- second row; extend and re-answer with the one that exists" -- see below.
  select token_hash into v_live
    from public.widget_link_tokens
   where member_id = p_member_id
     and purpose = p_purpose
     and promotion_id is not distinct from p_promotion_id
     and consumed_at is null
     and expires_at > now()
     and created_at > now() - interval '2 minutes'
   order by created_at desc
   limit 1;

  if v_live is not null then
    -- The caller asked again inside the window and we cannot hand back a code
    -- we only stored the hash of. So this answers NULL, and the caller (see
    -- src/services/whatsapp-link.ts) treats NULL as "already answered, send
    -- nothing" -- which is exactly what the window is for: one message.
    return null;
  end if;

  v_code := encode(gen_random_bytes(24), 'base64');
  -- URL-safe, and without padding: this value goes in a query string.
  v_code := replace(replace(rtrim(v_code, '='), '+', '-'), '/', '_');

  insert into public.widget_link_tokens
    (organization_id, company_id, member_id, public_key, purpose, promotion_id,
     token_hash, expires_at)
  values
    (v_install.organization_id, p_company_id, p_member_id, v_install.public_key,
     p_purpose, p_promotion_id,
     encode(digest(v_code, 'sha256'), 'hex'), now() + interval '15 minutes');

  return v_code;
end;
$$;

comment on function public.mint_widget_link is
  'Block 19a (D2). A single-use code, good for fifteen minutes, or NULL when this listener was already answered for this exact purpose inside the last two minutes -- NULL means "say nothing, they already have a working link", and is the whole of the protection against somebody sending the hashtag five times. Stores only the SHA-256; the raw code is returned once and never readable again, which is why the window answers NULL rather than repeating it. Refuses a Station with no live installation. Granted to service_role only: the caller is the worker.';

create function public.consume_widget_link(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.widget_link_tokens%rowtype;
begin
  -- ONE STATEMENT DECIDES IT. The predicate carries `consumed_at is null`, so
  -- two browsers opening the same link at the same instant race inside Postgres
  -- and exactly one row is returned -- the loser sees zero rows, not a stale
  -- read. A select-then-update would let both through.
  update public.widget_link_tokens
     set consumed_at = now()
   where token_hash = encode(digest(coalesce(p_code, ''), 'sha256'), 'hex')
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    -- One answer for expired, used and unknown, on purpose: the caller is a
    -- route handler serving a public URL and has nothing useful to do with the
    -- difference, while a distinct answer per cause hands a prober a way to
    -- tell them apart. The screen says "ask again", which is true of all three.
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  if not exists (
    select 1 from public.widget_installations
     where company_id = v_row.company_id and enabled and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;

  return jsonb_build_object(
    'ok',              true,
    'public_key',      v_row.public_key,
    'company_id',      v_row.company_id,
    'organization_id', v_row.organization_id,
    'member_id',       v_row.member_id,
    'purpose',         v_row.purpose,
    'promotion_id',    v_row.promotion_id);
end;
$$;

comment on function public.consume_widget_link is
  'Block 19a (D2). Trades a code for the claims a widget session is minted from, and burns it in the same statement -- the UPDATE carries `consumed_at is null` in its predicate, so two simultaneous opens have exactly one winner and the loser reads no row rather than a stale one. Expired, used and unknown are ONE answer: the caller serves a public URL and the difference would only help somebody probing. A Station switched off since the code was minted refuses separately, because that is a configuration an operator can act on.';

revoke execute on function public.mint_widget_link(uuid, uuid, public.widget_link_purpose, uuid) from public, anon, authenticated;
revoke execute on function public.consume_widget_link(text) from public, anon, authenticated;
grant execute on function public.mint_widget_link(uuid, uuid, public.widget_link_purpose, uuid) to service_role;
grant execute on function public.consume_widget_link(text) to service_role;
```

- [ ] **Step 4: Run until green**

Run: `npm run db:reset && npx supabase test db supabase/tests/45_widget_link_tokens.test.sql --local`
Expected: 10 of 10.

**If assertion 1 fails on `digest`**, the `pgcrypto` extension is present in this schema already (0031 hashes CPFs with it) — check the search path in the failing call rather than adding the extension a second time.

- [ ] **Step 5: Prove assertion 8 bites**

Replace `consume_widget_link` in psql with a select-then-update version, re-run, and confirm assertion 8 fails. Restore with `npm run db:reset`. A green race test that passes against a broken implementation proves nothing.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0178_widget_link_tokens.sql supabase/tests/45_widget_link_tokens.test.sql
git commit -m "feat(19a): a single-use door, good for fifteen minutes"
```

---

### Task 3: The ingest decides a link, and starts no new conversation

**Files:**
- Create: `supabase/migrations/0179_ingest_link_intent.sql`
- Modify: `supabase/tests/44_service_hashtags.test.sql` (matching assertions)

**Interfaces:**
- Consumes: Task 1's columns, `promotions.hashtag`.
- Produces: `ingest_whatsapp_event` returning, additionally, `{outcome: 'link', purpose, promotion_id, member_id, integration_id, phone, event_id, dedupe_prefix}` and **never** `{outcome: 'conversation'}`.

- [ ] **Step 1: Take the live body forward BY SCRIPT**

The live definition is `0070`'s, not `0062`'s. Do not retype it.

```bash
grep -l "function public.ingest_whatsapp_event" supabase/migrations/*.sql
node -e "const f=require('fs');const s=f.readFileSync('supabase/migrations/0070_start_conversation.sql','utf8');const i=s.indexOf('create function public.ingest_whatsapp_event');const j=s.indexOf('\$\$;', i);f.writeFileSync('supabase/migrations/0179_ingest_link_intent.sql', s.slice(i, j+3));console.log('extracted', j-i, 'chars')"
```

Then edit the extract: `create function` becomes `create or replace function`, and the header comment is rewritten for this block.

- [ ] **Step 2: Add the three assertions to `44_service_hashtags.test.sql`**

Raise its plan to 14 and add:

11. A message carrying the music hashtag returns `outcome = 'link'` with `purpose = 'MUSIC'`.
12. A message carrying the service hashtag returns `purpose = 'MENU'`.
13. A message carrying a LIVE promotion's hashtag returns `purpose = 'PROMOTION'` with that promotion's id — **even when `web_enabled` is false** (D4).
14. A promotion with no rules text returns outcome `no_rules`, and no link.

- [ ] **Step 3: Rewrite the decision**

Replace everything from the promotion match down to the end with:

```sql
  -- D3. Three hashtags, one order: the Station's live promotions, then its
  -- music hashtag, then its service hashtag. First match wins.
  --
  -- Promotions first because a promotion's hashtag is the specific word and the
  -- Station's two are the general ones, and because that is the order that was
  -- already true before this block -- reversing it would silently retire
  -- hashtags customers have printed on flyers.
  select * into v_promo
  from public.promotions
  where company_id = v_integ.company_id
    and lower(hashtag) = v_tag
    and deleted_at is null
    and cancelled_at is null
    and v_when >= starts_at and v_when < ends_at
  limit 1;

  select * into v_install
  from public.widget_installations
  where company_id = v_integ.company_id
    and enabled
    and deleted_at is null;

  if v_promo.id is not null then
    -- D4. RULES ARE THE CONSENT the listener accepts on the screen, and 17c
    -- writes that row. A promotion with none cannot be entered on the web at
    -- all, so answering with a link would be sending somebody to a door that
    -- refuses them. web_enabled is deliberately NOT tested: sending the hashtag
    -- IS asking to take part, and the flag governs only the widget's list.
    if v_promo.rules is null or btrim(v_promo.rules) = '' then
      return public.finish_whatsapp_event(v_event.id, 'no_rules', null, null);
    end if;
    v_purpose := 'PROMOTION';
  elsif v_install.music_hashtag is not null
        and lower(v_install.music_hashtag) = v_tag then
    v_purpose := 'MUSIC';
  elsif v_install.service_hashtag is not null
        and lower(v_install.service_hashtag) = v_tag then
    v_purpose := 'MENU';
  else
    -- The diagnostic of 0070 is kept exactly as it was: three answers for the
    -- operator asked "why didn't it work?", all silent to the listener.
    select * into v_diag
    from public.promotions
    where company_id = v_integ.company_id
      and lower(hashtag) = v_tag
      and deleted_at is null
    order by starts_at desc
    limit 1;

    if not found then
      v_outcome := 'no_promotion';
    elsif v_diag.cancelled_at is not null then
      v_outcome := 'promotion_cancelled';
    else
      v_outcome := 'outside_window';
    end if;
    return public.finish_whatsapp_event(v_event.id, v_outcome, null, null);
  end if;

  -- The listener, resolved or registered, exactly as before. (Keep 0070's two
  -- lookups and its unique_violation branch verbatim -- the second lookup is
  -- the one that stops a duplicate listener on every first message from a
  -- number an operator typed with a country code.)

  -- THE EVENT STAYS PROCESSING, and nothing is sent from here. What goes back
  -- is an intention: mint a code, build a URL that only Node knows the host of,
  -- and enqueue one message. That is the same division 0070 already used for a
  -- conversation, and it is what lets D7's bridge live in one place -- the
  -- caller checks for a live conversation first, and a listener mid-answer is
  -- never handed a link that would abandon what they already typed.
  return jsonb_build_object(
    'outcome',        'link',
    'event_id',       v_event.id,
    'integration_id', v_integ.id,
    'company_id',     v_integ.company_id,
    'phone',          v_local,
    'to_phone',       v_from,
    'member_id',      v_member,
    'purpose',        v_purpose,
    'promotion_id',   v_promo.id,
    'promotion_name', v_promo.name,
    'dedupe_prefix',  v_event.external_id);
```

Declare `v_install public.widget_installations%rowtype;` and `v_purpose text;` beside the existing declarations. **Delete nothing else**: the payload guards, the member resolution and `finish_whatsapp_event` calls stay as they are.

- [ ] **Step 4: Run the whole database suite**

Run: `npm run db:reset && npm run db:test`
Expected: every file passing. `41_widget_music_request` and the conversation files must be untouched — if a conversation test fails, the rewrite deleted something it should not have.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0179_ingest_link_intent.sql supabase/tests/44_service_hashtags.test.sql
git commit -m "feat(19a): a hashtag becomes an addressed door rather than a conversation"
```

---

### Task 4: The URL, and the message it travels in

**Files:** Create `src/lib/widget/service-link.ts`, `tests/unit/service-link.test.ts`

**Interfaces:**
- Produces:
  - `interface ServiceLinkIntent { publicKey: string; code: string; purpose: 'MUSIC' | 'MENU' | 'PROMOTION'; promotionId: string | null }`
  - `buildServiceLink(baseUrl: string, intent: ServiceLinkIntent): string`
  - `buildServiceMessage(text: string, link: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { buildServiceLink, buildServiceMessage } from '@/lib/widget/service-link';

const base = 'https://pulchatx.com';

it('addresses the music panel', () => {
  expect(
    buildServiceLink(base, { publicKey: 'pw_abc', code: 'xyz', purpose: 'MUSIC', promotionId: null }),
  ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz&open=music');
});

it('addresses one promotion by id', () => {
  expect(
    buildServiceLink(base, {
      publicKey: 'pw_abc',
      code: 'xyz',
      purpose: 'PROMOTION',
      promotionId: '00000000-0000-0000-0000-000000000009',
    }),
  ).toBe(
    'https://pulchatx.com/w/pw_abc/enter?k=xyz&open=promotion&id=00000000-0000-0000-0000-000000000009',
  );
});

it('addresses the menu with no destination at all', () => {
  expect(
    buildServiceLink(base, { publicKey: 'pw_abc', code: 'xyz', purpose: 'MENU', promotionId: null }),
  ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz');
});

/** A trailing slash on the configured site URL must not produce a double one. */
it('does not double the slash', () => {
  expect(
    buildServiceLink('https://pulchatx.com/', {
      publicKey: 'pw_abc',
      code: 'xyz',
      purpose: 'MENU',
      promotionId: null,
    }),
  ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz');
});

/**
 * The link is appended on its OWN LINE rather than interpolated into a
 * placeholder. A placeholder an operator can delete is a message that arrives
 * without its link, and nothing on any screen would show that.
 */
it('puts the link on its own line under the text', () => {
  expect(buildServiceMessage('Toque para pedir sua música:', 'https://x/y')).toBe(
    'Toque para pedir sua música:\n\nhttps://x/y',
  );
});

it('survives a Station whose text ends in whitespace', () => {
  expect(buildServiceMessage('Vamos lá!   \n', 'https://x/y')).toBe('Vamos lá!\n\nhttps://x/y');
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npx vitest run tests/unit/service-link.test.ts`
Expected: FAIL — cannot find module.

Implement with `URL`/`URLSearchParams` rather than string concatenation, so the code is escaped once and correctly.

- [ ] **Step 3: Commit**

```bash
npx vitest run tests/unit/service-link.test.ts
git add src/lib/widget/service-link.ts tests/unit/service-link.test.ts
git commit -m "feat(19a): the address a code becomes, and the message it arrives in"
```

---

### Task 5: The worker sends the link — unless a conversation is open

**Files:**
- Create: `src/services/whatsapp-link.ts`, `tests/unit/whatsapp-link.test.ts`
- Modify: `src/services/conversation.ts` (the branch in `runConversationTurn`)
- Modify: `src/lib/conversation/engine.ts` (three system message defaults)

**Interfaces:**
- Consumes: Task 2's doors, Task 4's builders.
- Produces: `sendServiceLink(deps: ConversationDeps, turn: LinkIntent): Promise<TurnOutcome>`

**D7's bridge is nearly free**, and this is why: `runConversationTurn` already loads the live conversation before acting on anything the message opened, and its own comment says a live conversation wins over a new hashtag. So the branch goes exactly where `open()` is called today.

- [ ] **Step 1: Write the failing test**

```typescript
import { sendServiceLink } from '@/services/whatsapp-link';

const intent = {
  outcome: 'link' as const,
  event_id: 'e1',
  integration_id: 'i1',
  company_id: 'c1',
  phone: '11999998888',
  to_phone: '5511999998888',
  member_id: 'm1',
  purpose: 'MUSIC' as const,
  promotion_id: null,
  promotion_name: null,
  dedupe_prefix: 'a'.repeat(64),
};

it('mints a code, enqueues one message carrying the link, and closes the event', async () => {
  const calls: string[] = [];
  const supabase = fakeSupabase({ mint_widget_link: 'CODE-1' }, calls);

  const outcome = await sendServiceLink({ supabase, store }, intent);

  expect(outcome).toEqual({ kind: 'link_sent' });
  expect(calls).toContain('rpc:mint_widget_link');
  expect(enqueued(calls)).toMatchObject({
    dedupe_key: `${'a'.repeat(64)}:link`,
    body: expect.stringContaining('/w/pw_test/enter?k=CODE-1&open=music'),
  });
});

/**
 * D2's window: the door answers null when this listener already has a working
 * link, and null means SAY NOTHING. A second message here is the whole defect
 * the window exists to prevent.
 */
it('sends nothing when the door says the listener was already answered', async () => {
  const calls: string[] = [];
  const supabase = fakeSupabase({ mint_widget_link: null }, calls);

  const outcome = await sendServiceLink({ supabase, store }, intent);

  expect(outcome).toEqual({ kind: 'already_answered' });
  expect(calls.filter((c) => c.startsWith('insert:outbox_messages'))).toHaveLength(0);
});

it('uses the Station's own wording when it has one', async () => {
  const supabase = fakeSupabase(
    { mint_widget_link: 'CODE-1', system_message: 'Bora pedir!' },
    [],
  );
  const { body } = await captureEnqueued(supabase, intent);
  expect(body.startsWith('Bora pedir!\n\n')).toBe(true);
});
```

- [ ] **Step 1b: The three keys, in their own migration**

A Station overrides a text by writing a row in `station_message_templates`, whose
`key` column is the enum `public.system_message_key` — ten values today. Three
new texts mean three new enum values, and `alter type … add value` **cannot share
a transaction with a statement that uses the value**, which is why 0166 and 0170
are files of their own. So this is `0180_service_link_messages.sql` and it holds
nothing else:

```sql
alter type public.system_message_key add value if not exists 'LINK_MUSIC';
alter type public.system_message_key add value if not exists 'LINK_MENU';
alter type public.system_message_key add value if not exists 'LINK_PROMOTION';
```

`SYSTEM_MESSAGE_DEFAULTS` in `engine.ts` is a `Record<SystemMessageKey, string>`,
so the compiler will demand the three entries the moment the generated types are
refreshed (`npm run db:types`). `listSystemMessages` builds the screen from that
record, so the Messages screen grows from ten rows to thirteen with no change of
its own — check `system-message-list.tsx` for a per-key label map and add the
three labels in all three catalogues if one exists.

- [ ] **Step 2: Implement `sendServiceLink`**

Mint → if null, `{kind: 'already_answered'}` and `finish(event, 'already_answered')` → else build the link with `env.NEXT_PUBLIC_SITE_URL`, resolve the wording through the existing `resolveSystemMessage`, insert into `outbox_messages` with `dedupe_key = '<prefix>:link'` and `on conflict do nothing`, then finish the event as `link_sent`.

The three defaults go in `engine.ts` beside the existing copy, in Portuguese:

```typescript
export const DEFAULT_MUSIC_LINK_TEXT =
  'Toque no link para pedir sua música. Ele vale por 15 minutos:';
export const DEFAULT_MENU_LINK_TEXT =
  'Toque no link para falar com a gente. Ele vale por 15 minutos:';
export const DEFAULT_PROMOTION_LINK_TEXT =
  'Toque no link para participar. Ele vale por 15 minutos:';
```

- [ ] **Step 3: Wire the branch in `runConversationTurn`**

Where `if (turn.start) return await open(deps, turn, key);` stands today, add the link intent **after** the `live` check, never before:

```typescript
    const live = await deps.store.load(key);
    if (live) return await advanceLive(deps, turn, live, key);
    // D7. A listener halfway through answering questions is NOT handed a link:
    // the branch above already returned. Nothing starts a new conversation any
    // more, so `open` is reachable only by a conversation the ingest can no
    // longer produce — kept until the last open one closes, then deleted.
    if (turn.link) return await sendServiceLink(deps, turn.link);
    if (turn.start) return await open(deps, turn, key);
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run tests/unit/whatsapp-link.test.ts && npm run typecheck
git add src/services/whatsapp-link.ts src/services/conversation.ts src/lib/conversation/engine.ts tests/unit/whatsapp-link.test.ts
git commit -m "feat(19a): the worker answers a hashtag with one link, and never interrupts a conversation"
```

---

### Task 6: The door the listener walks through

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/enter/route.ts`
- Modify: `src/lib/widget/session.ts` (`WidgetClaims.channel`), `tests/unit/widget-session.test.ts`

**Interfaces:**
- Consumes: Task 2's `consume_widget_link`.
- Produces: `GET /w/:publicKey/enter?k=<code>[&open=music|promotion&id=<uuid>]` → 303 to `/w/:publicKey[?open=…]`, with the session cookie set.

- [ ] **Step 1: Add the claim, with its test**

```typescript
it('carries the channel it was minted for', () => {
  const token = mintSession({ ...claims, channel: 'WHATSAPP' }, secret);
  expect(readSessionFor(token, secret, claims.publicKey)?.channel).toBe('WHATSAPP');
});

/** An old cookie minted before this block has no channel and must still work. */
it('reads a session minted before the channel existed', () => {
  const legacy = mintSession({ ...claims } as WidgetClaims, secret);
  expect(readSessionFor(legacy, secret, claims.publicKey)?.channel).toBeUndefined();
});
```

`channel?: 'WEB' | 'WHATSAPP'` — **optional**, because sessions minted by 17a's verification path exist in browsers right now and must not become invalid on deploy.

- [ ] **Step 2: Write the route handler**

```typescript
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicKey: string }> },
): Promise<Response> {
  const { publicKey } = await params;
  const url = new URL(request.url);
  const code = url.searchParams.get('k');

  // A missing or refused code lands on the widget carrying `link=expired`, and
  // the page says "ask for it again". NOT a 404: a listener who waited twenty
  // minutes has done nothing wrong, and a broken-looking page is what makes
  // them stop trusting the number they wrote to.
  if (!code) return redirectTo(publicKey, { link: 'expired' });

  const answer = await consumeWidgetLink(code);
  if (!answer.ok) return redirectTo(publicKey, { link: 'expired' });

  // The key the code was minted for, never the one in the address: a code
  // pasted onto another Station's URL must not mint a session there.
  if (answer.publicKey !== publicKey) return redirectTo(publicKey, { link: 'expired' });

  const token = mintSession(
    {
      publicKey: answer.publicKey,
      companyId: answer.companyId,
      organizationId: answer.organizationId,
      memberId: answer.memberId,
      phone: answer.phone,
      channel: 'WHATSAPP',
      exp: Math.floor(Date.now() / 1000) + WIDGET_SESSION_SECONDS,
    },
    secret,
  );
  // …set-cookie exactly as the verify action does (Path /w, HttpOnly, SameSite
  // Lax, Secure), then 303 to the widget with `open` preserved.
}
```

**303, not 302:** the browser must issue a fresh GET, and the code must not survive in the address bar.

- [ ] **Step 3: Prove it end to end by hand once**

Run the local stack, mint a code with psql, open the URL, and confirm: the cookie is set, the address bar no longer holds `k=`, and a second open of the same URL lands on `link=expired`.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run typecheck && npx vitest run tests/unit/widget-session.test.ts
git add "src/app/(widget)/w/[publicKey]/enter/" src/lib/widget/session.ts tests/unit/widget-session.test.ts
git commit -m "feat(19a): the door that trades a code for a session"
```

---

### Task 7: The widget opens where the link said

**Files:** Modify `src/app/(widget)/w/[publicKey]/page.tsx`, `menu.tsx`; `messages/{en,pt,es}.json`

- [ ] **Step 1: Read `open` and hand it to the menu**

`?open=music` opens the song panel immediately; `?open=promotion&id=<uuid>` opens that promotion's panel; anything else, and anything naming a promotion this listener cannot see, falls back to the menu. **A bad `open` is never an error** — it is a URL somebody may have edited, and the menu is a correct answer to all of them.

- [ ] **Step 2: The expired-link line**

`?link=expired` renders one sentence above the identify form: the link has expired, send the hashtag again. Three languages.

- [ ] **Step 3: Strings and gates**

```bash
node -e "const f=require('fs');const k=l=>Object.keys(JSON.parse(f.readFileSync('messages/'+l+'.json','utf8')).widget||{}).sort().join(',');if(k('en')!==k('pt')||k('en')!==k('es'))throw new Error('widget keys differ');console.log('three catalogues agree')"
npm run lint && npm run typecheck && npm run test && npm run build
git add "src/app/(widget)/" messages/
git commit -m "feat(19a): the widget opens on what the link asked for"
```

---

### Task 8: The two fields on the Messages screen

**Files:**
- Create: `src/app/(app)/templates/messages/hashtag-fields.tsx`
- Modify: `src/app/(app)/templates/messages/{page,actions}.tsx|ts`, `src/services/templates.ts`, `messages/{en,pt,es}.json`

- [ ] **Step 1: The read door, because there is no reading without one**

`widget_installations` carries RLS with **no policy** and its ACL revoked (0159):
every reader is inside a `SECURITY DEFINER` body, and even the service client is
refused with 42501. So the screen cannot read the two columns through PostgREST,
and `0182_service_hashtags_read.sql` adds:

```sql
create function public.service_hashtags_for(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.widget_installations%rowtype;
begin
  if not public.has_permission('templates.view', p_company_id) then
    raise exception 'permission denied: templates.view required' using errcode = '42501';
  end if;

  select * into v_row
    from public.widget_installations
   where company_id = p_company_id and deleted_at is null;

  -- A Station with no installation is not an error: the screen shows the two
  -- fields disabled with the reason, and creating an installation is a console
  -- act (0159). `installed` is what tells the two states apart, since both
  -- carry null hashtags.
  if not found then
    return jsonb_build_object('installed', false, 'music', null, 'service', null);
  end if;

  return jsonb_build_object(
    'installed', true,
    'music',     v_row.music_hashtag,
    'service',   v_row.service_hashtag);
end;
$$;
```

Granted to `authenticated`, revoked from `public`/`anon`. Note it reads
`deleted_at is null` but NOT `enabled`: a Station may configure its hashtags
before switching the widget on, and hiding the current values from an operator
who has not enabled it yet would look like the settings were lost.

- [ ] **Step 1b: Service and action**

`getServiceHashtags(companyId)` calls that door; `setServiceHashtags` calls Task 1's door with the caller's token, mapping `42501` → "you do not hold templates.manage", `22023` → the door's own sentence verbatim (it names the clashing hashtag), `P0002` → "this Station has no widget installation".

- [ ] **Step 2: The fields**

A card above the message list: two inputs, one Save, the door's refusal shown beside them. **Disabled with the reason when the Station has no installation** — do not hide them, or an operator cannot tell the feature from a permission problem.

- [ ] **Step 3: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run test
git add "src/app/(app)/templates/" src/services/templates.ts messages/
git commit -m "feat(19a): a Station types its two hashtags where it types its messages"
```

---

### Task 9: The journey, the load, the gates, the PR

- [ ] **Step 1: The e2e**

Create `tests/e2e/whatsapp-entry.spec.ts`: provision a Station, set a music hashtag on the Messages screen, POST a **correctly signed** webhook body carrying "quero uma música #MUSICA" from a number, run a tick, read `outbox_messages` for the link, open it in a browser context, and assert the widget renders identified with the song panel open. Then request a song and assert the row lands with `channel = 'WEB'`. Finally, open the same link again and assert the expired line.

Run: `rm -rf .next && npm run db:reset && docker restart supabase_kong_CRM_-_LISTENER && npm run seed:branding && npx playwright test tests/e2e/whatsapp-entry.spec.ts --workers=1`

- [ ] **Step 2: The load test, because "hundreds at once" is the requirement**

Create `tests/isolation/whatsapp-link-load.test.ts`: insert 200 `webhook_events` from 200 distinct phones at one Station, run the ingest+send path concurrently, and assert **200 outbox rows, each carrying a distinct code, each addressed to the phone that asked**. Assert no listener received two messages and no code appears twice.

This is the test that falls over if anybody later derives a code from shared state.

- [ ] **Step 3: Every suite, in CI's order**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run db:reset && npm run db:test
npm run test:isolation
npm run db:reset && docker restart supabase_kong_CRM_-_LISTENER && npm run seed:branding && npm run test:e2e
```

- [ ] **Step 4: Documents and PR**

`docs/WIDGET.md` gains the entry section: the three hashtags and their order, the fifteen minutes, the single use, the two-minute window, and that the reply is free-form inside the 24-hour window and therefore needs no approved template.

The PR body states D1–D8, that a promotion's hashtag now needs rules text or it answers unavailable, that conversations already open still finish, and that `0177`–`0179` are additive.

- [ ] **Step 5: After the merge**

Apply `0177`, `0178` and `0179` immediately: `npx supabase migration list --linked`. Never `supabase db reset --linked`.

---

## Self-Review

**Spec coverage.** D1 → Tasks 3–7. D2 → Task 2 (the fifteen minutes, the single use, the window) and Task 6 (the burn). D3 → Task 3, assertions 11–13. D4 → Task 3's `web_enabled` omission and its `no_rules` branch. D5 → **19b, not here** (§11). D6 → Tasks 1 and 8. D7 → Task 5, Step 3, and it costs one line because `runConversationTurn` already prefers a live conversation. D8 → Task 5's three defaults, editable through the screen 0109 already built. §7's failure table → Task 6 (`link=expired`), Task 3 (`no_rules`), Task 2 (`unavailable`). §8's four suites → Tasks 1, 2, 4, 5, 9.

**Type consistency.** `ServiceLinkIntent` (Task 4) is the shape Task 5 builds from the ingest's `link` object (Task 3); `purpose` is the same three-value union in the enum, the JSON and the TypeScript. `WidgetClaims.channel` (Task 6) is optional in exactly one place and read in one other (19b's shell).

**One gap found and closed.** The first draft had `mint_widget_link` returning the existing code inside the two-minute window. It cannot: only the hash is stored, so the raw value is unrecoverable. The window therefore answers **null**, and null means *say nothing* — which is the same protection expressed honestly, and Task 5's second test pins it.
