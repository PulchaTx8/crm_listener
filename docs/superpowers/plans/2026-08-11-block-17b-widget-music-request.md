# Block 17b — Widget Music Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A listener identified by Block 17a searches Deezer inside the embedded widget, picks a recording, optionally leaves a note, and the request lands in `music_requests` with channel `WEB`.

**Architecture:** Two migrations (an enum value alone, then everything that uses it), two `security definer` doors granted to `service_role` only, a new `track(id)` on the Deezer transport, two server actions in a new `music-actions.ts`, and one client panel with four steps. The per-Station ceiling is an **interval between requests**, not a count.

**Tech Stack:** Next.js 15 App Router (server actions), Supabase Postgres 17, pgTAP, Vitest, Playwright, next-intl, Zod, Tailwind.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-11-block-17b-widget-music-request-design.md`. Every decision D1–D6 lives there; this plan implements it and does not re-decide.
- **Migrations are numbered `0166` and `0167`.** The repository is at `0165`. Confirm with `ls supabase/migrations | tail -3` before creating either.
- **`ALTER TYPE … ADD VALUE` gets its own file**, because it cannot share a transaction with a statement that uses the value (0082, 0091, 0151, 0160).
- **Every widget door is `security definer`, `set search_path = pg_catalog, public`, `revoke execute … from public`, `grant execute … to service_role`.** No exceptions — `widget_installations` has RLS on and its ACL revoked, so it is reachable only inside such a body.
- **Every user-visible string goes through the next-intl catalogue in all three languages** (`messages/en.json`, `messages/pt-BR.json`, `messages/es.json`). No literal copy in a component, error messages included.
- **`readSessionFor`, never `readSession`,** in anything that serves a request. It is the only call that proves the session was minted for *this* installation.
- **Node 24.** `npm run lint` covers `src` and `tests` only; `scripts/` is not linted.
- **Local stack:** `npm run db:reset` (guarded, local only) then `npm run seed:demo`. `npm run db:test` needs a freshly reset database.

---

## File Structure

| file | responsibility |
| --- | --- |
| `supabase/migrations/0166_widget_music_channel.sql` | the `WEB` enum value, alone |
| `supabase/migrations/0167_widget_music_request.sql` | two columns, two doors, comments, grants |
| `supabase/tests/41_widget_music_request.test.sql` | pgTAP for both doors |
| `src/lib/integrations/deezer/transport.ts` | `track(id)` added to the interface |
| `src/lib/integrations/deezer/client.ts` | its implementation |
| `src/schemas/widget-music.ts` | the two input shapes |
| `src/app/(widget)/w/[publicKey]/music-actions.ts` | `searchSongsAction`, `requestSongAction` |
| `src/app/(widget)/w/[publicKey]/request-song.tsx` | the four-step panel |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | panel state; first button enabled |
| `src/app/(admin)/admin/stations/widget-tab.tsx` | days / hours / minutes fields |
| `src/app/(app)/music/requests/requests-grid.tsx` | the note, visible to the operator |
| `tests/e2e/widget-music.spec.ts` | the journey |

---

### Task 1: The enum value

**Files:**
- Create: `supabase/migrations/0166_widget_music_channel.sql`

**Interfaces:**
- Produces: `'WEB'` as a value of `public.music_request_channel`, usable by every later task.

- [ ] **Step 1: Confirm the migration number**

Run: `ls supabase/migrations | tail -3`
Expected: the highest is `0165_template_otp_button.sql`. If it is not, renumber this task's file and every later one.

- [ ] **Step 2: Write the migration**

```sql
-- supabase/migrations/0166_widget_music_channel.sql

-- Block 17b. ONE ADD VALUE AND NOTHING ELSE IN THIS FILE.
--
-- The Postgres rule 0082, 0091, 0151 and 0160 each paid for: ALTER TYPE ...
-- ADD VALUE cannot share a transaction with a statement that USES the value.
-- Separate files are separate transactions, and 0167 uses this one.

alter type public.music_request_channel add value 'WEB';

comment on type public.music_request_channel is
  'How a music request reached this product. MANUAL is an operator typing it; IMPORT is the legacy migration; API is Block 15''s external intake door; WEB is Block 17b -- a listener on the Station''s own website, through the embedded widget.';
```

- [ ] **Step 3: Apply and verify**

Run: `npm run db:reset`
Then: `docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -t -c "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'music_request_channel' order by enumsortorder;"`
Expected: `MANUAL, IMPORT, API, WEB`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0166_widget_music_channel.sql
git commit -m "feat(17b): WEB joins the music request channels"
```

---

### Task 2: The columns and the two doors

**Files:**
- Create: `supabase/migrations/0167_widget_music_request.sql`
- Create: `supabase/tests/41_widget_music_request.test.sql`

**Interfaces:**
- Consumes: `'WEB'` (Task 1); `public.apply_song_intake(...)` (0152).
- Produces:
  - `public.widget_music_request_wait(p_public_key text, p_member_id uuid) returns jsonb` — `{"ok":true,"wait_seconds":N}` or `{"ok":false,"reason":"..."}`
  - `public.widget_record_music_request(p_public_key text, p_member_id uuid, p_deezer_track_id bigint, p_title text, p_artist_name text, p_album_title text, p_duration_seconds integer, p_isrc text, p_cover_md5 text, p_deezer_album_id bigint, p_upc text, p_label_name text, p_genre_name text, p_release_date date, p_note text) returns jsonb`
  - `widget_installations.music_request_cooldown interval not null default '0'`
  - `music_requests.listener_note text`

**Note on the return shape:** both doors answer `jsonb` with `ok` and a named `reason`, the contract `widget_request_code` and `widget_verify_code` already use, so `readAnswer` in the actions layer keeps working unchanged.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/41_widget_music_request.test.sql`. Follow the fixture style of `supabase/tests/40_widget_verification.test.sql` — read it first for how it provisions an Organization, a Station, an installation and a member.

```sql
begin;
select plan(14);

-- Fixtures: one Organization, two Stations, an installation on each, one member
-- linked to Station A only. Build them the way 40_widget_verification.test.sql
-- does; the ids below are the names that file uses for the same things.

-- 1. A recording lands with channel WEB and no programme.
select lives_ok($$
  select public.widget_record_music_request(
    'pw_aaaaaaaaaaaaaaaaaaaaaa', (select id from public.members where full_name = 'Widget Listener'),
    3135556, 'Sozinho (Ao Vivo)', 'Caetano Veloso', 'Prenda Minha', 231,
    'BRXXX0000001', 'abc123', 302127, '0123456789012', 'Universal', 'MPB',
    '1998-01-01'::date, 'toca pra minha mae')
$$, 'a verified listener records a request');

select is(
  (select channel::text from public.music_requests order by created_at desc limit 1),
  'WEB', 'the request carries channel WEB');

select is(
  (select show_id from public.music_requests order by created_at desc limit 1),
  null, 'a web request carries no programme (D5)');

select is(
  (select listener_note from public.music_requests order by created_at desc limit 1),
  'toca pra minha mae', 'the note is stored');

select is(
  (select actor_id from public.audit_logs where action = 'widget_record_music_request'
    order by created_at desc limit 1),
  null, 'the audit row names no actor (0129)');

-- 2. Zero cooldown is unlimited: a second request immediately after succeeds.
select lives_ok($$
  select public.widget_record_music_request(
    'pw_aaaaaaaaaaaaaaaaaaaaaa', (select id from public.members where full_name = 'Widget Listener'),
    3135557, 'Outra', 'Caetano Veloso', 'Prenda Minha', 200,
    null, null, 302127, null, null, null, null, null)
$$, 'zero cooldown lets a listener ask again at once');

-- 3. With a cooldown set, the second request is refused and says how long.
update public.widget_installations
   set music_request_cooldown = interval '30 minutes'
 where public_key = 'pw_aaaaaaaaaaaaaaaaaaaaaa';

select is(
  (select public.widget_record_music_request(
     'pw_aaaaaaaaaaaaaaaaaaaaaa', (select id from public.members where full_name = 'Widget Listener'),
     3135558, 'Terceira', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'cooldown', 'inside the interval it refuses by name');

select ok(
  ((select public.widget_music_request_wait(
      'pw_aaaaaaaaaaaaaaaaaaaaaa',
      (select id from public.members where full_name = 'Widget Listener')) ->> 'wait_seconds')::integer) between 1 and 1800,
  'the read-only door says how many seconds are left');

-- 4. THE BOUNDARY. One second past the interval passes; one second inside does not.
update public.music_requests
   set requested_at = now() - interval '30 minutes' - interval '1 second'
 where channel = 'WEB';

select is(
  (select public.widget_record_music_request(
     'pw_aaaaaaaaaaaaaaaaaaaaaa', (select id from public.members where full_name = 'Widget Listener'),
     3135559, 'Quarta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'ok'),
  'true', 'one second past the interval is allowed');

-- 5. Cross-Station: Station B's key with Station A's listener.
select is(
  (select public.widget_record_music_request(
     'pw_bbbbbbbbbbbbbbbbbbbbbb', (select id from public.members where full_name = 'Widget Listener'),
     3135560, 'Quinta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'unknown_listener', 'a listener of another Station is refused');

-- 6. An unknown key.
select is(
  (select public.widget_record_music_request(
     'pw_zzzzzzzzzzzzzzzzzzzzzz', (select id from public.members where full_name = 'Widget Listener'),
     3135561, 'Sexta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'unknown_installation', 'an unknown key is refused');

-- 7. Anonymised listeners are refused (0034).
update public.members set anonymized_at = now() where full_name = 'Widget Listener';
select is(
  (select public.widget_record_music_request(
     'pw_aaaaaaaaaaaaaaaaaaaaaa', (select id from public.members where full_name = 'Widget Listener'),
     3135562, 'Setima', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'listener_anonymized', 'an anonymised listener is refused');
update public.members set anonymized_at = null where full_name = 'Widget Listener';

-- 8. The note's ceiling is the column's, not only the form's.
select throws_ok($$
  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, channel, listener_note)
  select organization_id, company_id, id, (select id from public.songs limit 1), 'WEB', repeat('x', 501)
    from public.members where full_name = 'Widget Listener'
$$, '23514', null, 'a note over 500 characters is refused by the check');

-- 9. The read-only door refuses a stranger rather than answering 0.
select is(
  (select public.widget_music_request_wait(
     'pw_bbbbbbbbbbbbbbbbbbbbbb',
     (select id from public.members where full_name = 'Widget Listener')) ->> 'reason'),
  'unknown_listener', 'the wait door does not answer about another Station''s listener');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.widget_record_music_request(...) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0167_widget_music_request.sql

-- Block 17b. The two columns and the two doors behind the widget's first
-- button. Design: docs/superpowers/specs/2026-08-11-block-17b-widget-music-request-design.md

alter table public.music_requests
  add column listener_note text
    constraint music_requests_note_length check (length(listener_note) <= 500);

comment on column public.music_requests.listener_note is
  'What a listener typed alongside the request, Block 17b (D3). Operator-visible only -- nothing publishes it anywhere automatically. Null for every request that did not arrive through the widget.';

-- NOT NULL WITH ZERO MEANING "NO CEILING", rather than nullable. Both spell
-- unlimited; having both is two representations of one fact, and it is always
-- the second one that some future `where` clause forgets to handle.
alter table public.widget_installations
  add column music_request_cooldown interval not null default '0'
    constraint widget_installations_cooldown_not_negative
      check (music_request_cooldown >= interval '0');

comment on column public.widget_installations.music_request_cooldown is
  'How long a listener waits between music requests at this Station, Block 17b (D2). Zero is no ceiling at all. Written from three form fields via make_interval(days, hours, mins) and read back with extract() -- Postgres does not normalise across those units, so 36 hours stays 36 hours and the operator reads back what they typed.';

-- ---------------------------------------------------------------------------
-- The shared half. Both doors answer the same three questions before they do
-- anything else, and a second implementation of "is this listener allowed to
-- ask here" is exactly the drift 0061's cores were extracted to prevent.
-- ---------------------------------------------------------------------------
create function public.widget_music_request_context(
  p_public_key text,
  p_member_id  uuid,
  out o_company uuid,
  out o_org     uuid,
  out o_wait    integer,
  out o_reason  text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cooldown interval;
  v_last     timestamptz;
begin
  -- ONE ANSWER for unknown, disabled, archived and suspended, which is the
  -- choice 0161 and 0164 already made: probing teaches nothing the iframe's
  -- `src` did not already say.
  select i.company_id, i.organization_id, i.music_request_cooldown
    into o_company, o_org, v_cooldown
    from public.widget_installations i
    join public.companies c
      on c.id = i.company_id and c.deleted_at is null
     and c.status = 'active' and c.suspended_at is null
   where i.public_key = p_public_key
     and i.deleted_at is null
     and i.enabled;

  if not found then
    o_reason := 'unknown_installation';
    return;
  end if;

  -- THE LISTENER IS CHECKED AGAINST THE STATION THE KEY NAMES, never against
  -- anything the caller supplied. The signed session already proves this; the
  -- door proves it again against the database, because the cookie's Path is
  -- `/w` -- one path for every installation this deployment serves -- and a
  -- door that trusts its caller is one bug in a route away from writing into
  -- another Station (api_record_music_request says the same in its own words).
  if not exists (
    select 1
      from public.members m
      join public.member_company_links l
        on l.member_id = m.id and l.company_id = o_company
     where m.id = p_member_id
       and m.organization_id = o_org
       and m.deleted_at is null
  ) then
    o_reason := 'unknown_listener';
    return;
  end if;

  if exists (select 1 from public.members where id = p_member_id and anonymized_at is not null) then
    -- 0034's erasure. Recording fresh activity against somebody who exercised
    -- it is what that erasure was for, and it is never cured by a new row.
    o_reason := 'listener_anonymized';
    return;
  end if;

  o_wait := 0;

  if v_cooldown > interval '0' then
    -- D6: only what the widget produced. An operator recording a request on a
    -- listener's behalf does not spend that listener's web quota.
    select max(requested_at) into v_last
      from public.music_requests
     where member_id = p_member_id
       and company_id = o_company
       and channel = 'WEB'
       and deleted_at is null;

    if v_last is not null and v_last + v_cooldown > now() then
      o_wait := ceil(extract(epoch from (v_last + v_cooldown - now())))::integer;
    end if;
  end if;
end;
$$;

comment on function public.widget_music_request_context is
  'Block 17b. The three refusals both widget music doors share -- unknown_installation, unknown_listener, listener_anonymized -- plus how many seconds of the Station''s cooldown are left. Internal: the two doors below are what callers use.';

-- ---------------------------------------------------------------------------
-- The read-only door. It exists so nobody is invited to do work that is going
-- to be refused: without it a visitor searches, chooses, writes a note and
-- submits before learning they must wait two hours.
-- ---------------------------------------------------------------------------
create function public.widget_music_request_wait(
  p_public_key text,
  p_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v public.widget_music_request_context%rowtype;
begin
  select * into v from public.widget_music_request_context(p_public_key, p_member_id);

  -- NOT `0` FOR A SESSION IT CANNOT VERIFY. "You may ask now" followed by a
  -- refusal at submit is a worse answer than the refusal, and answering a
  -- stranger's question about a listener at another Station leaks whether that
  -- listener exists.
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  return jsonb_build_object('ok', true, 'wait_seconds', v.o_wait);
end;
$$;

-- ---------------------------------------------------------------------------
-- The write.
-- ---------------------------------------------------------------------------
create function public.widget_record_music_request(
  p_public_key       text,
  p_member_id        uuid,
  p_deezer_track_id  bigint,
  p_title            text,
  p_artist_name      text,
  p_album_title      text    default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_cover_md5        text    default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_release_date     date    default null,
  p_note             text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v         public.widget_music_request_context%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_song    jsonb;
  v_request uuid;
  v_locked  uuid;
begin
  -- THE LOCK COMES BEFORE THE CHECK, and that order is the whole point. Without
  -- it two simultaneous submissions both read the same "last request" and both
  -- pass -- a ceiling in name only. It is the cure widget_verify_code uses for
  -- its five-attempt ceiling, for the same reason.
  select id into v_locked from public.members where id = p_member_id for update;

  select * into v from public.widget_music_request_context(p_public_key, p_member_id);

  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  if v.o_wait > 0 then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'wait_seconds', v.o_wait);
  end if;

  -- THE SAME CORE BLOCK 15'S TWO ENDPOINTS CALL, so "registering a song" cannot
  -- come to mean two different things at two doors. p_actor is null: a website
  -- visitor is not an auth.users row.
  v_song := public.apply_song_intake(
    v.o_company, v.o_org, null,
    null, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, null, null, p_duration_seconds, p_isrc,
    null, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, created_by, listener_note)
  values
    (v.o_org, v.o_company, p_member_id, (v_song ->> 'song_id')::uuid, null, 'WEB',
     now(), null, v_note)
  returning id into v_request;

  -- actor_id null, and 0129 states in writing that a null there does not mean
  -- "the system did it".
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'widget_record_music_request', 'music_requests', v_request, v.o_org, v.o_company,
     jsonb_build_object('public_key', p_public_key, 'song', v_song,
                        'has_note', v_note is not null));

  return jsonb_build_object('ok', true, 'request_id', v_request, 'song', v_song);
end;
$$;

comment on function public.widget_record_music_request is
  'Block 17b. Records what a listener asked for from the Station''s own website, registering the song through apply_song_intake if the Station does not have it. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, cooldown -- so the widget can tell a visitor which happened. The member row is locked BEFORE the cooldown is read: without it two simultaneous submissions both pass. channel is WEB and show_id is null (D5); actor_id on the audit row is null because a website visitor is not an auth.users row (0129). Granted to service_role only.';

revoke execute on function public.widget_music_request_context(text, uuid) from public;
revoke execute on function public.widget_music_request_wait(text, uuid) from public;
revoke execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text, bigint, text, text, text, date, text) from public;

grant execute on function public.widget_music_request_wait(text, uuid) to service_role;
grant execute on function public.widget_record_music_request(
  text, uuid, bigint, text, text, text, integer, text, text, bigint, text, text, text, date, text) to service_role;
```

- [ ] **Step 4: Run the tests until they pass**

Run: `npm run db:reset && npm run db:test`
Expected: `41_widget_music_request.test.sql` — 14 of 14.
If `apply_song_intake` complains about a null `p_external_id`, read its body around line 200 of `0152_api_intake_doors.sql`: `v_external` is `nullif(btrim(...))`, so null is accepted and the ladder falls through to ISRC and to Deezer id.

- [ ] **Step 5: Prove the grants did not widen**

Run: `npm run test:isolation`
Expected: green. If the isolation suite has a case listing `widget_installations` columns, add `music_request_cooldown` to it — the column must stay unreadable to `anon` and `authenticated`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0167_widget_music_request.sql supabase/tests/41_widget_music_request.test.sql
git commit -m "feat(17b): the two doors behind the widget's first button"
```

---

### Task 3: `track(id)` on the Deezer transport

**Files:**
- Modify: `src/lib/integrations/deezer/transport.ts`
- Modify: `src/lib/integrations/deezer/client.ts`
- Test: `tests/lib/integrations/deezer/client.test.ts` (extend the existing file)

**Interfaces:**
- Produces: `DeezerTransport.track(trackId: number): Promise<DeezerResult<DeezerTrack>>` — the same `DeezerTrack` the search returns.

**Why:** D4. The browser sends an integer, so the server has to be able to turn an integer into a recording.

- [ ] **Step 1: Write the failing test**

```typescript
it('reads one track by id', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      id: 3135556,
      title: 'Sozinho (Ao Vivo)',
      duration: 231,
      isrc: 'BRXXX0000001',
      md5_image: 'abc123',
      preview: 'https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1~hmac=y',
      artist: { name: 'Caetano Veloso' },
      album: { id: 302127, title: 'Prenda Minha' },
    }),
  });

  const result = await createDeezerClient({ fetchImpl }).track(3135556);

  expect(fetchImpl).toHaveBeenCalledWith(
    'https://api.deezer.com/track/3135556',
    { headers: { accept: 'application/json' } },
  );
  expect(result).toEqual({
    ok: true,
    value: {
      id: 3135556,
      title: 'Sozinho (Ao Vivo)',
      artistName: 'Caetano Veloso',
      albumId: 302127,
      albumTitle: 'Prenda Minha',
      coverMd5: 'abc123',
      durationSeconds: 231,
      isrc: 'BRXXX0000001',
      previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1~hmac=y',
    },
  });
});

it('reads a not-found track that arrived as HTTP 200', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ error: { type: 'DataException', message: 'no data', code: 800 } }),
  });

  const result = await createDeezerClient({ fetchImpl }).track(999999999999);

  expect(result).toMatchObject({ ok: false, reason: 'not-found' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/integrations/deezer/client.test.ts -t "one track by id"`
Expected: FAIL — `track is not a function`.

- [ ] **Step 3: Add the method to the interface**

In `transport.ts`, inside `DeezerTransport`:

```typescript
  /**
   * One recording, by id. Block 17b (D4): the widget sends an integer rather
   * than a record, so a crafted payload cannot name what lands in the
   * catalogue -- which means the server needs a way to turn that integer back
   * into a recording. Same mapping as a search hit, so both paths produce the
   * same `DeezerTrack`.
   */
  track(trackId: number): Promise<DeezerResult<DeezerTrack>>;
```

- [ ] **Step 4: Implement it**

In `client.ts`, beside `album`. Reuse whatever the search already uses to map a raw Deezer track object — if that mapping is inline in `search`, extract it to a `toTrack(raw)` function first and have both call it, so the two paths cannot drift.

```typescript
    async track(trackId) {
      const result = await call<unknown>(`${BASE}/track/${trackId}`, fetchImpl);
      if (!result.ok) return result;
      return toTrackResult(result.value);
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/lib/integrations/deezer/`
Expected: PASS, including every pre-existing case — the extraction in Step 4 must not change what `search` returns.

- [ ] **Step 6: Commit**

```bash
git add src/lib/integrations/deezer/ tests/lib/integrations/deezer/
git commit -m "feat(17b): the Deezer transport can read one track by id"
```

---

### Task 4: The input shapes

**Files:**
- Create: `src/schemas/widget-music.ts`
- Test: `tests/schemas/widget-music.test.ts`

**Interfaces:**
- Produces: `searchSchema`, `requestSongSchema`, and the inferred types.

- [ ] **Step 1: Write the failing test**

```typescript
import { requestSongSchema, searchSchema } from '@/schemas/widget-music';

it('refuses a query shorter than two characters', () => {
  expect(searchSchema.safeParse({ query: 'a' }).success).toBe(false);
  expect(searchSchema.safeParse({ query: 'ab' }).success).toBe(true);
});

it('refuses a note over 500 characters, the column ceiling', () => {
  const base = { deezerTrackId: '3135556' };
  expect(requestSongSchema.safeParse({ ...base, note: 'x'.repeat(500) }).success).toBe(true);
  expect(requestSongSchema.safeParse({ ...base, note: 'x'.repeat(501) }).success).toBe(false);
});

it('takes the track id off a form as a string and yields a number', () => {
  const parsed = requestSongSchema.parse({ deezerTrackId: '3135556', note: '' });
  expect(parsed.deezerTrackId).toBe(3135556);
  expect(parsed.note).toBeUndefined();
});

it('refuses a track id that is not a positive integer', () => {
  for (const id of ['0', '-3', '1.5', 'abc', '']) {
    expect(requestSongSchema.safeParse({ deezerTrackId: id, note: '' }).success).toBe(false);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/schemas/widget-music.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schemas**

```typescript
import { z } from 'zod';

/**
 * Block 17b. What the widget's music panel posts, and the only shapes
 * `music-actions.ts` will act on.
 *
 * STRICT, like `src/schemas/widget.ts` and for the same reason: a field name
 * this product does not know did not come from the form this product renders.
 */

/** Two characters minimum -- the panel debounces, and one letter is not a search. */
export const searchSchema = z
  .object({ query: z.string().trim().min(2).max(120) })
  .strict();

/**
 * THE TRACK ID IS THE WHOLE PAYLOAD (D4). A form field is always a string, so
 * it is parsed rather than coerced: `z.coerce.number()` accepts '1.5' and
 * ' 12 ' and turns '' into 0, and a Deezer id is a positive integer or it is
 * nothing.
 *
 * 500 is the column's CHECK in 0167, repeated here so a refusal from the
 * database is never the first news of it -- the same duplication
 * `publicKeySchema` carries for 0159's key shape.
 */
export const requestSongSchema = z
  .object({
    deezerTrackId: z
      .string()
      .regex(/^[1-9]\d{0,17}$/, 'not a Deezer track id')
      .transform((value) => Number(value)),
    note: z
      .string()
      .trim()
      .max(500)
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
  })
  .strict();

export type SearchInput = z.infer<typeof searchSchema>;
export type RequestSongInput = z.infer<typeof requestSongSchema>;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/schemas/widget-music.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/widget-music.ts tests/schemas/widget-music.test.ts
git commit -m "feat(17b): the shapes the widget's music panel may post"
```

---

### Task 5: The two server actions

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/music-actions.ts`
- Test: `tests/app/widget/music-actions.test.ts`

**Interfaces:**
- Consumes: `searchSchema`, `requestSongSchema` (Task 4); `track`, `album`, `search` (Task 3); `widget_music_request_wait`, `widget_record_music_request` (Task 2); `readSessionFor`, `WIDGET_SESSION_COOKIE` (17a); `PostgresRateLimiter`, `createServiceClient`, `callerIp`.
- Produces:
  - `searchSongsAction(previous: SearchState, formData: FormData): Promise<SearchState>`
  - `requestSongAction(previous: RequestState, formData: FormData): Promise<RequestState>`
  - `getWaitAction(publicKey: string): Promise<{ ok: true; waitSeconds: number } | { ok: false; reason: RequestRefusal }>` — the read-only door, called by the panel on mount (Task 6). Not a `useActionState` pair: it takes no form and answers a question rather than performing a submission.
  - `type SearchState = { status: 'idle' } | { status: 'results'; tracks: WidgetTrack[] } | { status: 'refused'; reason: SearchRefusal }`
  - `type RequestState = { status: 'idle' } | { status: 'recorded' } | { status: 'refused'; reason: RequestRefusal; waitSeconds?: number }`
  - `interface WidgetTrack { id: number; title: string; artistName: string; albumTitle: string; coverMd5: string | null; durationSeconds: number }`

**Read first:** `src/app/(widget)/w/[publicKey]/actions.ts` lines 40–140 (the limit constants and `withinLimits`) and 162–250 (`requestCodeAction`). This task copies that structure exactly: secret check, parse, limit, spend.

- [ ] **Step 1: Write the failing tests**

```typescript
it('refuses a search when the session belongs to another Station', async () => {
  // cookie minted for pw_bbb..., form posts pw_aaa...
  const state = await searchSongsAction({ status: 'idle' }, formFor('pw_aaaaaaaaaaaaaaaaaaaaaa', 'sozinho'));
  expect(state).toEqual({ status: 'refused', reason: 'no_session' });
});

it('never sends the preview url to the browser', async () => {
  // the Deezer stub returns previewUrl; the action's result must not carry it
  const state = await searchSongsAction({ status: 'idle' }, formFor(KEY, 'sozinho'));
  expect(state.status).toBe('results');
  expect(JSON.stringify(state)).not.toContain('hdnea');
});

it('maps a Deezer quota refusal to its own reason', async () => {
  deezer.search.mockResolvedValue({ ok: false, reason: 'quota', message: 'too many' });
  const state = await searchSongsAction({ status: 'idle' }, formFor(KEY, 'sozinho'));
  expect(state).toEqual({ status: 'refused', reason: 'deezer_quota' });
});

it('passes the cooldown seconds through so the screen can say how long', async () => {
  rpc.mockResolvedValue({ data: { ok: false, reason: 'cooldown', wait_seconds: 742 }, error: null });
  const state = await requestSongAction({ status: 'idle' }, requestFormFor(KEY, '3135556', ''));
  expect(state).toEqual({ status: 'refused', reason: 'cooldown', waitSeconds: 742 });
});

it('takes the member from the session, never from the form', async () => {
  await requestSongAction({ status: 'idle' }, requestFormFor(KEY, '3135556', '', { memberId: 'attacker' }));
  expect(rpc).toHaveBeenCalledWith('widget_record_music_request',
    expect.objectContaining({ p_member_id: SESSION_MEMBER_ID }));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/widget/music-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the actions**

Key requirements, each of which has a test above:

```typescript
'use server';

// Search: 20 per minute per IP, 60 per minute per Station. A debounced panel
// asks at most twice a second and a human types in bursts; this is a ceiling on
// a robot, not on a listener.
const SEARCH_PER_IP_MINUTE = { limit: 20, windowSeconds: 60 } as const;
const SEARCH_PER_STATION_MINUTE = { limit: 60, windowSeconds: 60 } as const;
// Submitting is cheap to refuse and expensive to allow: it can create a
// catalogue row. The per-listener ceiling is the Station's cooldown, in the
// database; this is the one the database cannot express, because it has no idea
// what an IP is (0161's own comment).
const REQUEST_PER_IP_HOUR = { limit: 30, windowSeconds: 3600 } as const;
```

- Both actions: `publicKeySchema.safeParse(formData.get('publicKey'))` first, then read the cookie and `readSessionFor(token, secret, publicKey)`. A null session is `{ status: 'refused', reason: 'no_session' }`.
- `searchSongsAction` calls `createDeezerClient().search({ track: query })` and maps the result to `WidgetTrack` — **id, title, artistName, albumTitle, coverMd5, durationSeconds and nothing else**. `previewUrl` is dropped: `transport.ts` says in writing that it carries a signed `hdnea=exp=…~hmac=…` stamp and must not be stored or forwarded.
- `requestSongAction` calls `track(id)`, then `album(track.albumId)`, then the RPC with `p_member_id: claims.memberId`.
- An album failure is **not** fatal: UPC, label, genre and release date are enrichment. Log it and pass nulls. A `track` failure is fatal — there is nothing to record.
- Map `DeezerFailureReason` → `'quota' → 'deezer_quota'`, `'not-found' → 'not_found'`, `'network' | 'malformed' → 'deezer_unavailable'`.
- Reuse `readAnswer` from `actions.ts`; if it is not exported, export it there rather than writing a second one.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/app/widget/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(widget)/w/[publicKey]/music-actions.ts" tests/app/widget/music-actions.test.ts
git commit -m "feat(17b): the two server actions behind the widget's music panel"
```

---

### Task 6: The panel

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/request-song.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/menu.tsx`
- Modify: `messages/en.json`, `messages/pt-BR.json`, `messages/es.json`

**Interfaces:**
- Consumes: `searchSongsAction`, `requestSongAction`, `WidgetTrack` (Task 5).
- Produces: `<RequestSongPanel publicKey={string} onClose={() => void} />`.

- [ ] **Step 1: Enable the button and hold the panel state**

`menu.tsx` keeps its comment about why the tooltip does not name a block number. The first button loses `disabled` and `title`, gains `onClick`; the second keeps both, and its comment shrinks to 17c alone.

- [ ] **Step 2: Write the panel**

Four steps in one component, in this order: **search → choose → note → done**.

- On mount, call `requestSongAction`'s sibling — the wait door, through a small `getWaitAction` added in Task 5 — and if `wait_seconds > 0`, render the wait message instead of the search box.
- Search input: `useState` + `useEffect` with a 400 ms debounce and a two-character minimum, matching `searchSchema`.
- Results: cover from `https://cdn-images.dzcdn.net/images/cover/<coverMd5>/56x56-000000-80-0-0.jpg`, title, artist, album, duration as `m:ss`. Already allowed by `img-src` in `src/lib/security/csp.ts` (Block 13a).
- Note: `<textarea maxLength={500}>` with a live counter.
- Every string from `useTranslations('widget')`. Add the keys to all three catalogues in the same commit.

- [ ] **Step 3: Check the catalogues have not drifted**

Run: `node -e "const a=require('./messages/en.json'),b=require('./messages/pt-BR.json'),c=require('./messages/es.json');const k=o=>Object.keys(o.widget||{}).sort().join(',');if(k(a)!==k(b)||k(a)!==k(c))throw new Error('widget keys differ across languages');console.log('three catalogues agree')"`
Expected: `three catalogues agree`.

- [ ] **Step 4: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(widget)/w/[publicKey]/" messages/
git commit -m "feat(17b): the widget's music panel, in three languages"
```

---

### Task 7: The console fields

**Files:**
- Modify: `src/app/(admin)/admin/stations/widget-tab.tsx`
- Modify: the action that saves it (`saveWidgetInstallationAction`, same folder)
- Modify: `messages/en.json`, `messages/pt-BR.json`, `messages/es.json`
- Test: extend the existing widget-tab action test

**Interfaces:**
- Consumes: `widget_installations.music_request_cooldown` (Task 2).

- [ ] **Step 1: Write the failing test**

```typescript
it('writes three form fields as one interval', async () => {
  await saveWidgetInstallationAction(IDLE, formWith({ cooldownDays: '0', cooldownHours: '1', cooldownMinutes: '30' }));
  expect(rpc).toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ p_music_request_cooldown: '0 days 1 hours 30 mins' }));
});

it('treats all three zero as no ceiling', async () => {
  await saveWidgetInstallationAction(IDLE, formWith({ cooldownDays: '0', cooldownHours: '0', cooldownMinutes: '0' }));
  expect(rpc).toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ p_music_request_cooldown: '0 days 0 hours 0 mins' }));
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

Three `<input type="number" min="0">` fields — days, hours, minutes — with a sentence above them saying that all zero means no limit. The save action composes the interval string; the door writes it with `make_interval`. Reading back uses `extract(day|hour|minute from music_request_cooldown)`.

- [ ] **Step 3: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm run test
git add "src/app/(admin)/admin/stations/" messages/
git commit -m "feat(17b): a Station sets the wait between web music requests"
```

---

### Task 8: The note, where the operator reads it

**Files:**
- Modify: `src/app/(app)/music/requests/requests-grid.tsx`
- Modify: whatever query feeds it (same folder — check `page.tsx` and `list-params.ts`)
- Modify: the three catalogues

- [ ] **Step 1: Add `listener_note` to the query, then the column**

The note is often empty and sometimes long: render it under the song title in muted text rather than as its own column, and truncate at two lines with the full text in `title`.

- [ ] **Step 2: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm run test
git add "src/app/(app)/music/requests/" messages/
git commit -m "feat(17b): the listener's note reaches the operator's screen"
```

---

### Task 9: The journey

**Files:**
- Create: `tests/e2e/widget-music.spec.ts`

**Read first:** `tests/e2e/widget.spec.ts` — it already identifies a visitor through the code flow, and this journey starts where that one ends.

- [ ] **Step 1: Write the journey**

Identify → open the panel → type two characters → pick the first result → write a note → submit → see the confirmation. Then sign in as the operator and find the request on `/music/requests` with its note and channel.

**Deezer must not be reached from CI.** Check how `tests/e2e/` stubs outbound HTTP today — if there is no pattern, use `page.route('**/api.deezer.com/**', …)` and serve a fixed payload. A journey that depends on a third party is a journey that goes red on their outage.

- [ ] **Step 2: Run it**

Run: `npm run db:reset && npm run seed:branding && npx playwright test tests/e2e/widget-music.spec.ts`
Expected: PASS. If chunks 404 or the layout collapses, kill any `next dev` and `rm -rf .next` first — a stale dev server serves a dead `layout.css` and the mobile header stops being hidden, which fails on strict-mode violations that look like application defects.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/widget-music.spec.ts
git commit -m "test(17b): the journey from a website visitor to a request on the operator's screen"
```

---

### Task 10: The full gate, and the PR

- [ ] **Step 1: Run every suite in the order CI does**

```bash
npm run lint
npm run typecheck
npm run test
npm run db:reset && npm run db:test
npm run test:isolation
npm run db:reset && npm run seed:branding && npm run test:e2e
```

`npm run db:test` needs a freshly reset database — after an e2e or isolation run one music test fails on leftover state, and that is not a regression.

- [ ] **Step 2: Update the block's documentation**

Add 17b to `docs/WIDGET.md`: the two doors, the cooldown column and what zero means, and the fact that the catalogue now grows from public input.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin block-17b-widget-music-request
gh pr create --base main --title "Block 17b — a listener on the Station's own site asks for a song" --body "..."
```

The body states: what shipped, the six decisions, the interval model and its 23:50 consequence, and the two risks from §12 of the spec.

- [ ] **Step 4: Apply the migrations to the hosted project after the merge**

The merge triggers an EasyPanel deploy and **migrations do not travel with it**. Run `npx supabase migration list --linked` and apply `0166` and `0167`. This cost Block 13a a production outage.

**Never `supabase db reset --linked`** — `npm run db:reset` refuses it, and `.claude/settings.json` denies the raw command, but a terminal is a terminal.

---

## Self-Review

**Spec coverage.** §3 D1 → Tasks 3, 5, 6. D2 → Tasks 2, 7. D3 → Tasks 2, 6, 8. D4 → Tasks 3, 4, 5. D5 → Task 2 (`show_id` null, pinned by pgTAP). D6 → Task 2 (`channel = 'WEB'` in the cooldown query). §4 storage → Task 2. §5.1/5.2/5.3 → Tasks 2, 2, 3. §6 → Task 6. §7 refusals → Tasks 2 and 5. §8 → the tests inside each task plus Task 10. §9 → Tasks 1 and 2. §10 → Tasks 3–8. §12 risks → the PR body, Task 10.

**Type consistency.** `WidgetTrack` is defined in Task 5 and consumed in Task 6 under that name. The doors' argument lists in Task 2 match the calls in Task 5. `wait_seconds` is the key in the door's JSON and `waitSeconds` in the TypeScript state — deliberate, and the mapping happens in Task 5.

**One gap found and closed:** Task 6 needs the wait door before the panel renders, and Task 5's interface list did not produce an action for it. `getWaitAction` is named in Task 6 Step 2 and must be written in Task 5 alongside the other two.
