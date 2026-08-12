# Block 19b — Widget Presentation and Exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A widget opened outside an iframe draws itself as a full-height
application with the Station's picture and name at the top, and every screen
that ends an errand — plus the menu — offers a "Sair" that clears the session
and says goodbye.

**Architecture:** One new SECURITY DEFINER door (`widget_station_identity`)
answers name, picture and WhatsApp number for a public key, read with the anon
key exactly as `installationExists` already reads `widget_frame_context`. The
page reads `Sec-Fetch-Dest` and wraps its two existing states in one of two
server-rendered frames; the embedded frame is byte-for-byte what
`(widget)/layout.tsx` imposes today, which is why that layout becomes a
pass-through. Sign-out is a server action beside the two the widget already has,
and the farewell is client state owned by `WidgetMenu`, so no page reload
exposes the cleared cookie.

**Tech Stack:** Next.js 15 App Router (React 19 server components), Supabase
Postgres with SECURITY DEFINER doors, `next-intl`, Tailwind, vitest, pgTAP,
Playwright.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-block-19b-widget-presentation-and-exit-design.md`. Every decision below traces to it.
- **Migrations start at `0185`.** The repository is at `0184`. One migration in this block.
- **Code, comments, documentation and commit messages are in English.** UI copy lives in `messages/{en,pt,es}.json` and never in a component.
- **All three locale files change together.** `tests/unit/i18n/catalogue.test.ts` and `tests/unit/i18n/usage.test.ts` fail on a key present in one file and missing from another, and on a `t('key')` with no entry.
- **No new key names a block number or this project's vocabulary to a listener.** The widget is read by somebody's mother on a radio station's website.
- **The identity door answers `found: false` for five causes alike**: unknown key, disabled installation, archived installation, suspended Station (`companies.status`), blocked Organization (`organizations.suspended_at`). A distinct refusal publishes a customer's billing status.
- **Every widget door is granted narrowly.** `revoke execute … from public` then `grant execute … to anon, service_role`, in that order.
- **`npm run db:types` after any migration**, and the regenerated `src/lib/supabase/database.types.ts` is committed with it.
- **Six gates before the branch is done:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:test`, `npm run test:e2e`.

---

## File Structure

**Created:**

| path | responsibility |
| --- | --- |
| `supabase/migrations/0185_widget_station_identity.sql` | the door: name, picture, WhatsApp number for a public key |
| `supabase/tests/48_widget_station_identity.test.sql` | pgTAP: the shape, the five refusals, the grant |
| `src/lib/widget/station-identity.ts` | pure: the answer's shape, and a number reduced to a `wa.me` address |
| `src/lib/widget/presentation.ts` | pure: `Sec-Fetch-Dest` → `'embedded' \| 'app'` |
| `src/app/(widget)/w/[publicKey]/frames.tsx` | the two frames, server components |
| `src/app/(widget)/w/[publicKey]/farewell.tsx` | the goodbye panel, client |
| `tests/unit/widget-station-identity.test.ts` | unit: parser and `wa.me` address |
| `tests/unit/widget-presentation.test.ts` | unit: the four header cases |
| `tests/unit/widget-sign-out.test.ts` | unit: the cookie the action clears |

**Modified:**

| path | change |
| --- | --- |
| `src/services/widget-installations.ts` | gains `stationIdentity(publicKey)` beside `installationExists` |
| `src/app/(widget)/layout.tsx` | stops imposing width and transparency; becomes a pass-through |
| `src/app/(widget)/w/[publicKey]/page.tsx` | chooses the frame, reads identity for the application one |
| `src/app/(widget)/w/[publicKey]/actions.ts` | gains `signOutAction` |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | `exitHref` prop, `left` state, "Sair" under the two errands |
| `src/app/(widget)/w/[publicKey]/request-song.tsx` | `onExit` prop; "Sair" on the recorded screen |
| `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` | `onExit` prop; "Sair" on the entered and declined screens |
| `messages/en.json`, `messages/pt.json`, `messages/es.json` | four keys in the `widget` namespace |
| `tests/e2e/whatsapp-entry.spec.ts` | the header appears from the WhatsApp door; framed, it does not |
| `tests/e2e/widget.spec.ts` | "Sair" reaches the farewell; a reload lands on the identify form |
| `docs/WIDGET.md` | the two presentations and the exit |

---

## Task 1: The identity door

**Files:**
- Create: `supabase/migrations/0185_widget_station_identity.sql`
- Create: `supabase/tests/48_widget_station_identity.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: nothing.
- Produces: `public.widget_station_identity(p_public_key text) returns jsonb`, answering
  `{"found": bool, "name": text|null, "thumb_url": text|null, "whatsapp_number": text|null}`.
  Granted to `anon` and `service_role`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/48_widget_station_identity.test.sql`:

```sql
begin;
select plan(10);

-- Block 19b, Task 1. The door the application presentation reads to draw its
-- header. Fixtures follow 39_widget_installations: one Organization, one
-- Station, one installation -- plus a second Organization/Station pair, because
-- four of the five refusals are produced by SWITCHING SOMETHING OFF, and doing
-- that to the live fixture would poison every assertion after it.

select has_function('public', 'widget_station_identity', array['text'],
  'the identity door exists');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000001e1', 'Org identity');
insert into public.companies (id, organization_id, name, timezone, thumb_url) values
  ('00000000-0000-0000-0000-0000000001f1', '00000000-0000-0000-0000-0000000001e1',
   'Radio Identity', 'America/Sao_Paulo', 'https://example.test/thumb.png');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled)
values
  ('00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-0000000001e1',
   '00000000-0000-0000-0000-0000000001f1', 'pw_identityaaaabbbbcccc', true);
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, display_phone_number, enabled)
values
  ('00000000-0000-0000-0000-000000001201',
   '00000000-0000-0000-0000-0000000001e1',
   '00000000-0000-0000-0000-0000000001f1', 'WHATSAPP', '111222333', '+55 11 98888-7777', true);

select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'name',
  'Radio Identity', 'a live installation answers with the Station name');

select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'thumb_url',
  'https://example.test/thumb.png', 'and with the picture the console wrote');

select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'whatsapp_number',
  '+55 11 98888-7777', 'and with the number a listener wrote to');

-- REFUSAL 1 of 5. Each one is its own assertion on purpose: a single
-- "an unknown key is refused" test passes against a function that forgot all
-- four joins, which is exactly the defect 0164 was written to repair.
select is(
  public.widget_station_identity('pw_nosuchkeyaaaabbbbcccc') ->> 'found',
  'false', 'an unknown key is not found');

-- REFUSAL 2: the installation switched off.
update public.widget_installations set enabled = false
 where id = '00000000-0000-0000-0000-000000001101';
select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'found',
  'false', 'a disabled installation is not found');
update public.widget_installations set enabled = true
 where id = '00000000-0000-0000-0000-000000001101';

-- REFUSAL 3: the installation archived.
update public.widget_installations set deleted_at = now()
 where id = '00000000-0000-0000-0000-000000001101';
select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'found',
  'false', 'an archived installation is not found');
update public.widget_installations set deleted_at = null
 where id = '00000000-0000-0000-0000-000000001101';

-- REFUSAL 4: the Station suspended. This is 0164's whole reason for existing --
-- a Station suspended for non-payment went on being framed until somebody
-- disabled the installation by hand.
update public.companies set status = 'suspended'
 where id = '00000000-0000-0000-0000-0000000001f1';
select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'found',
  'false', 'a suspended Station is not found');
update public.companies set status = 'active'
 where id = '00000000-0000-0000-0000-0000000001f1';

-- REFUSAL 5: the Organization blocked.
update public.organizations set suspended_at = now()
 where id = '00000000-0000-0000-0000-0000000001e1';
select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') ->> 'found',
  'false', 'a blocked Organization is not found');
update public.organizations set suspended_at = null
 where id = '00000000-0000-0000-0000-0000000001e1';

-- A switched-off integration leaves the header intact and the farewell without
-- its button: found, named, pictured, and no number.
update public.integrations set enabled = false
 where id = '00000000-0000-0000-0000-000000001201';
select is(
  public.widget_station_identity('pw_identityaaaabbbbcccc') -> 'whatsapp_number',
  'null'::jsonb, 'a switched-off integration yields no number, and the rest still answers');

-- The grant is exactly anon and service_role. `authenticated` is not on the
-- list and must not drift onto it: a door this wide open needs its audience
-- pinned by a test, not by the migration that happens to be read last.
select is(
  (select array_agg(g order by g) from (
     select unnest(array['anon', 'authenticated', 'service_role']) as g) roles
    where has_function_privilege(g, 'public.widget_station_identity(text)', 'execute')),
  array['anon', 'service_role'],
  'anon and service_role may execute it, and authenticated may not');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.widget_station_identity(text) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0185_widget_station_identity.sql`:

```sql
-- supabase/migrations/0185_widget_station_identity.sql

-- Block 19b, Task 1. Who a widget belongs to, for the header the application
-- presentation draws above the panels.
--
-- WHY A DOOR AND NOT A TABLE READ. `widget_installations` carries RLS with no
-- policy and its ACL revoked (0159, whose own comment records that even
-- `createServiceClient().from('widget_installations')` fails with 42501), so
-- every reader of it is inside a SECURITY DEFINER body. `companies` is
-- readable, but resolving a public key to a company is precisely the step that
-- needs the revoked table.
--
-- THE FIVE JOINS ARE 0164's, COPIED RATHER THAN SUMMARISED. An unknown key, a
-- disabled installation, an archived one, a SUSPENDED Station and a BLOCKED
-- Organization all answer `found: false`. A distinct reason per cause would
-- publish a customer's billing status to anybody who loads their home page --
-- 0164's argument, and it applies here unchanged because this door answers the
-- same anonymous visitor from the same public key.
--
-- WHAT THIS PUBLISHES, STATED RATHER THAN ASSUMED: a caller holding a public
-- key learns a Station's name, its picture and its WhatsApp number. All three
-- are already on the Station's own website -- the website whose page carries
-- that public key in an <iframe src> (0159's column comment says the key
-- travels there). The key proves nothing here it did not already prove.

create function public.widget_station_identity(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'name', c.name,
              'thumb_url', c.thumb_url,
              -- A SCALAR SUBQUERY RATHER THAN A SIXTH JOIN, because a Station
              -- with no integration must still be found: joining would turn
              -- "no WhatsApp number" into "no such widget", which is the one
              -- direction this must not fail in. At most one row can match --
              -- integrations_one_per_company (0057) is unique on
              -- (company_id, provider) where deleted_at is null.
              'whatsapp_number', (
                select i.display_phone_number
                  from public.integrations i
                 where i.company_id = c.id
                   and i.provider = 'WHATSAPP'
                   and i.enabled
                   and i.deleted_at is null))
       from public.widget_installations w
       join public.companies c
         on c.id = w.company_id
        and c.deleted_at is null
        and c.status = 'active'
       join public.organizations o
         on o.id = w.organization_id
        and o.suspended_at is null
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object(
      'found', false, 'name', null, 'thumb_url', null, 'whatsapp_number', null));
$$;

revoke execute on function public.widget_station_identity(text) from public;
grant execute on function public.widget_station_identity(text) to anon, service_role;

comment on function public.widget_station_identity(text) is
  'The Station name, picture and WhatsApp number behind one public key, for the header the widget draws when it is opened outside an iframe (Block 19b, D2). Answers {"found": false} with every field null for an unknown key, a disabled installation, an archived one, a SUSPENDED Station and a BLOCKED Organization alike -- one answer for five causes, so probing learns nothing and the caller has one refusal branch to get right; a distinct reason would publish a customer''s billing status to anybody loading their home page (0164). whatsapp_number is null when the Station has no WhatsApp integration, when it is switched off, and when the operator never typed a number in -- the header still draws, and the farewell simply omits its button back to the conversation. GRANTED TO anon deliberately: the caller is the widget page serving an anonymous visitor, the same reason widget_frame_context is (0161).';
```

- [ ] **Step 4: Reset, run the test, regenerate types**

Run: `npm run db:reset && npm run db:test`
Expected: `48_widget_station_identity.test.sql .. ok`, 10 of 10.

Then run: `npm run db:types`
Expected: `src/lib/supabase/database.types.ts` gains a `widget_station_identity` entry under `Functions`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0185_widget_station_identity.sql supabase/tests/48_widget_station_identity.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(19b): a door that answers who a widget belongs to"
```

---

## Task 2: Reading the door in Node

**Files:**
- Create: `src/lib/widget/station-identity.ts`
- Create: `tests/unit/widget-station-identity.test.ts`
- Modify: `src/services/widget-installations.ts` (add `stationIdentity` after `installationExists`, before the `Block 17a, Task 11` console section)

**Interfaces:**
- Consumes: `widget_station_identity(p_public_key)` from Task 1.
- Produces:
  - `interface StationIdentity { name: string; thumbUrl: string | null; whatsappHref: string | null }`
  - `readStationIdentity(data: unknown): StationIdentity | null`
  - `whatsappHref(displayNumber: string | null): string | null`
  - `stationIdentity(publicKey: string): Promise<StationIdentity | null>` (async, from the service)

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/widget-station-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readStationIdentity, whatsappHref } from '@/lib/widget/station-identity';

describe('whatsappHref', () => {
  it('reduces an operator-typed number to the digits wa.me takes', () => {
    expect(whatsappHref('+55 11 98888-7777')).toBe('https://wa.me/5511988887777');
  });

  it('passes bare digits through unchanged', () => {
    expect(whatsappHref('5511988887777')).toBe('https://wa.me/5511988887777');
  });

  it('answers null for no number at all', () => {
    expect(whatsappHref(null)).toBeNull();
  });

  it('answers null rather than a dead link when nothing survives the reduction', () => {
    // An operator who typed a note into the number box. A `wa.me/` with no
    // digits is a link that opens an error, which is worse than no button.
    expect(whatsappHref('(a definir)')).toBeNull();
  });
});

describe('readStationIdentity', () => {
  const found = {
    found: true,
    name: 'Radio Identity',
    thumb_url: 'https://example.test/thumb.png',
    whatsapp_number: '+55 11 98888-7777',
  };

  it('maps a found answer, address included', () => {
    expect(readStationIdentity(found)).toEqual({
      name: 'Radio Identity',
      thumbUrl: 'https://example.test/thumb.png',
      whatsappHref: 'https://wa.me/5511988887777',
    });
  });

  it('keeps the identity when there is no picture and no number', () => {
    expect(readStationIdentity({ ...found, thumb_url: null, whatsapp_number: null })).toEqual({
      name: 'Radio Identity',
      thumbUrl: null,
      whatsappHref: null,
    });
  });

  it('answers null for a refusal', () => {
    expect(
      readStationIdentity({ found: false, name: null, thumb_url: null, whatsapp_number: null }),
    ).toBeNull();
  });

  it('answers null for a shape it does not know, rather than an identity with a hole in it', () => {
    expect(readStationIdentity({ found: true, name: null })).toBeNull();
    expect(readStationIdentity(null)).toBeNull();
    expect(readStationIdentity([])).toBeNull();
    expect(readStationIdentity('found')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/widget-station-identity.test.ts`
Expected: FAIL — cannot resolve `@/lib/widget/station-identity`.

- [ ] **Step 3: Write the pure module**

Create `src/lib/widget/station-identity.ts`:

```ts
/**
 * Block 19b. What the application presentation draws above the panels, and the
 * one reader for the door that answers it.
 *
 * NOT `server-only`, and deliberately unlike its neighbour `session.ts`: these
 * two functions touch no secret and no request, and the parser is the shape a
 * unit test asserts without a database. The privileged half — the RPC call —
 * lives in `src/services/widget-installations.ts`, which is `server-only`.
 */
export interface StationIdentity {
  name: string;
  thumbUrl: string | null;
  /** Already an address, not a number: the component that draws it has no business reducing digits. */
  whatsappHref: string | null;
}

/**
 * `integrations.display_phone_number` is typed by an operator into a free-text
 * box, so `+55 11 98888-7777` and `5511988887777` both arrive. wa.me takes
 * digits and nothing else.
 *
 * NOTHING SURVIVING THE REDUCTION IS `null`, NOT `https://wa.me/`. An operator
 * who typed a note into the number box would otherwise produce a button that
 * opens an error page, and a listener who taps it learns that the Station's
 * widget is broken rather than that its number is unrecorded.
 */
export function whatsappHref(displayNumber: string | null): string | null {
  if (displayNumber === null) return null;
  const digits = displayNumber.replace(/\D/g, '');
  return digits === '' ? null : `https://wa.me/${digits}`;
}

/**
 * `widget_station_identity` (0185) answers a `jsonb` object, which reaches
 * supabase-js as `Json` — so the shape is checked rather than asserted, the
 * discipline `readAnswer` (door-answer.ts) and `readLinkAnswer` (enter/route.ts)
 * already apply to their own doors.
 *
 * ONE `null` FOR A REFUSAL AND FOR AN UNKNOWN SHAPE, unlike those two, and it
 * is safe here precisely because the caller has nothing to distinguish: the
 * page draws the header or does not, and §7 of the design says an unreachable
 * door is a missing header rather than a missing page. There is no second
 * branch for a reason to feed.
 */
export function readStationIdentity(data: unknown): StationIdentity | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (row.found !== true) return null;
  if (typeof row.name !== 'string') return null;
  return {
    name: row.name,
    thumbUrl: typeof row.thumb_url === 'string' ? row.thumb_url : null,
    whatsappHref: whatsappHref(typeof row.whatsapp_number === 'string' ? row.whatsapp_number : null),
  };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/unit/widget-station-identity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the service read**

In `src/services/widget-installations.ts`, add this import beside the existing ones:

```ts
import { readStationIdentity, type StationIdentity } from '@/lib/widget/station-identity';
```

and re-export the type so the page has one import for both halves:

```ts
export type { StationIdentity };
```

Then add this function immediately after `installationExists`, above the
`// Block 17a, Task 11` divider comment:

```ts
/**
 * Block 19b. The Station behind a public key, for the header the application
 * presentation draws — `null` when there is nothing to draw.
 *
 * THE ANON KEY, same as `installationExists` above and for the same reason:
 * 0185 grants this door to `anon` precisely because its caller is a page served
 * to an anonymous visitor. A service-role client here would be privilege with
 * no use.
 *
 * A DATABASE THAT CANNOT ANSWER RETURNS `null`, and this is the ONE place in
 * this file where a throw would be wrong — `installationExists` throws on
 * purpose, because collapsing an outage into "no such installation" answers 404
 * to a Station whose configuration is correct. Here the caller has already
 * decided the installation exists; all that is left is a name and a picture,
 * and design §7 says an unreachable door costs the header, never the page. A
 * throw would take a working widget down to decorate it.
 */
export async function stationIdentity(publicKey: string): Promise<StationIdentity | null> {
  if (!publicKey) return null;

  const { url, anonKey } = getUserSupabaseConfig();
  const supabase = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc('widget_station_identity', {
    p_public_key: publicKey,
  });
  if (error) return null;

  return readStationIdentity(data);
}
```

- [ ] **Step 6: Verify the whole unit suite and types**

Run: `npm test && npm run typecheck`
Expected: PASS both. `stationIdentity` typechecks against the regenerated
`database.types.ts` from Task 1 — if `widget_station_identity` is not in that
file, Task 1's step 4 was skipped.

- [ ] **Step 7: Commit**

```bash
git add src/lib/widget/station-identity.ts src/services/widget-installations.ts tests/unit/widget-station-identity.test.ts
git commit -m "feat(19b): read the identity door, and reduce a typed number to an address"
```

---

## Task 3: The presentation decision

**Files:**
- Create: `src/lib/widget/presentation.ts`
- Create: `tests/unit/widget-presentation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type WidgetPresentation = 'embedded' | 'app'` and
  `choosePresentation(secFetchDest: string | null): WidgetPresentation`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/widget-presentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { choosePresentation } from '@/lib/widget/presentation';

describe('choosePresentation', () => {
  it('is embedded inside a frame, which is what the widget was built for', () => {
    expect(choosePresentation('iframe')).toBe('embedded');
  });

  it('is an application for a top-level navigation', () => {
    expect(choosePresentation('document')).toBe('app');
  });

  it('is an application when the header is absent', () => {
    // Failing to the application costs a framed widget a header it should not
    // have; failing to the embed costs a WhatsApp listener the whole block.
    expect(choosePresentation(null)).toBe('app');
  });

  it('is an application for any other destination', () => {
    expect(choosePresentation('empty')).toBe('app');
    expect(choosePresentation('embed')).toBe('app');
  });

  it('does not care about the case a proxy rewrote the value in', () => {
    expect(choosePresentation('IFRAME')).toBe('embedded');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/widget-presentation.test.ts`
Expected: FAIL — cannot resolve `@/lib/widget/presentation`.

- [ ] **Step 3: Write the module**

Create `src/lib/widget/presentation.ts`:

```ts
/**
 * Block 19b, D1. Which of the widget's two presentations a request gets.
 *
 * `Sec-Fetch-Dest` AND NOTHING ELSE, and in particular NOT the session's
 * `channel` claim, which was this block's first instinct and is wrong. The
 * cookie's `Path` is `/w` — one path for every installation this deployment
 * serves (session.ts says so at length) — so a browser that arrived from a
 * WhatsApp link and later loads the same Station's website carries a `WHATSAPP`
 * claim into a request that genuinely IS an iframe, and would be drawn as a
 * full-height application inside a sidebar. The header answers the question
 * actually being asked: is there a frame around me.
 *
 * THE HEADER ABSENT IS AN APPLICATION. Every browser this product supports
 * sends `Sec-Fetch-Dest`; something that does not is likelier to be a script or
 * a very old browser opening the address directly than a modern site framing
 * it. The two failures are not symmetric — failing to the application costs a
 * framed widget a header it should not have, and failing to the embed costs a
 * WhatsApp listener a narrow transparent column in an empty tab, which is the
 * complaint this block exists to answer.
 */
export type WidgetPresentation = 'embedded' | 'app';

export function choosePresentation(secFetchDest: string | null): WidgetPresentation {
  return secFetchDest?.toLowerCase() === 'iframe' ? 'embedded' : 'app';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/widget-presentation.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget/presentation.ts tests/unit/widget-presentation.test.ts
git commit -m "feat(19b): the frame decides the presentation, not the session claim"
```

---

## Task 4: The two frames

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/frames.tsx`
- Modify: `src/app/(widget)/layout.tsx` (replace the whole component body)
- Modify: `src/app/(widget)/w/[publicKey]/page.tsx` (the return, and the imports)

**Interfaces:**
- Consumes: `choosePresentation` (Task 3), `stationIdentity` and `StationIdentity` (Task 2).
- Produces: `<EmbeddedFrame>` and `<AppFrame identity={StationIdentity | null}>`, both server components taking `children`.

There is no automated test in this task — `npm run build` and Task 7's e2e are
its gates. A unit test of a server component that renders a `<style>` element
would assert the markup this task writes, not the behaviour it produces.

- [ ] **Step 1: Write the frames**

Create `src/app/(widget)/w/[publicKey]/frames.tsx`:

```tsx
import type { StationIdentity } from '@/services/widget-installations';

/**
 * Block 19b, §6. The two shapes the widget's one page can take.
 *
 * THESE MOVED OUT OF `(widget)/layout.tsx`, which imposed the embedded shape on
 * every request because there was only one. A layout cannot make this choice:
 * it does not see the request's `Sec-Fetch-Dest`, and it wraps the route
 * regardless of what the route decided. So the layout became a pass-through and
 * both shapes live here, beside the page that picks between them.
 *
 * SERVER COMPONENTS, with no `'use client'`: neither frame has state, and the
 * `<style href=… precedence=…>` mechanism below is React 19's own hoisting,
 * which works from the server.
 */

/**
 * What every widget has been since Block 17a: a 28rem column on somebody else's
 * page, with nothing of this product's chrome around it.
 *
 * TRANSPARENT, so the Station's own page shows through around the widget.
 * `globals.css` paints `body` with `bg-background` (a faint cool grey) for the
 * application, and inside an iframe that grey is a rectangle sitting on
 * somebody else's design.
 *
 * `href` + `precedence` is what makes React hoist this into <head> and dedupe
 * it rather than emit a <style> in the body — the supported React 19 mechanism,
 * not a trick. It survives the CSP because `style-src` carries
 * `'unsafe-inline'` (src/lib/security/csp.ts, which explains at length why that
 * keyword is there for the style ATTRIBUTE React emits everywhere); this rule
 * needs no nonce as a result.
 *
 * 28rem is Tailwind's `max-w-md` exactly. A widget is a column in somebody
 * else's sidebar, not a page: wider and it stops fitting where a Station will
 * actually put it.
 */
export function EmbeddedFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style href="widget-surface" precedence="high">{`html,body{background:transparent}`}</style>
      <div className="mx-auto w-full max-w-md p-4">{children}</div>
    </>
  );
}

/**
 * What a listener who tapped a link inside WhatsApp gets: a screen with a floor,
 * a Station's name at the top of it, and buttons a thumb can hit.
 *
 * THE HEADER IS OPTIONAL AND THE PANELS ARE NOT. `identity` is null when the
 * door could not be reached or refused (design §7): the frame still draws, and
 * a listener still asks for their song. A Station's name is not worth a screen
 * nobody can use.
 *
 * THE STYLE BLOCK RATHER THAN `globals.css`, which is the same argument the
 * embedded frame's transparency rule has always made: the widget's visual rules
 * do not enter the file every other screen in this product shares. A SECOND
 * `href`, because React dedupes by that name and these two rules must never be
 * mistaken for one another — no request gets both.
 *
 * CHECKBOXES AND RADIOS ARE EXCLUDED FROM THE TOUCH-TARGET RULE, and it is not
 * a nicety: 17c's consent box and its option list are `input[type=checkbox]`
 * and `input[type=radio]`, and a 2.75rem minimum height turns each of them into
 * a tall rectangle beside its label.
 */
export function AppFrame({
  identity,
  children,
}: {
  identity: StationIdentity | null;
  children: React.ReactNode;
}) {
  return (
    <div data-widget-presentation="app" className="min-h-dvh bg-background">
      <style href="widget-app-surface" precedence="high">{`
        html,body{background:hsl(var(--background))}
        [data-widget-presentation='app'] button,
        [data-widget-presentation='app'] select,
        [data-widget-presentation='app'] textarea,
        [data-widget-presentation='app'] input:not([type='checkbox']):not([type='radio']){
          min-height:2.75rem;font-size:1rem
        }
      `}</style>

      {identity !== null && (
        <header
          className="flex items-center gap-3 border-b bg-card px-4 py-3 text-card-foreground"
          data-testid="widget-station-header"
        >
          {identity.thumbUrl ? (
            // A plain <img> rather than next/image, the same choice
            // request-song.tsx makes for Deezer covers: this page is served to
            // a listener on a Station's own terms and the optimiser would put
            // this deployment's host in front of an image the Station already
            // serves. `alt` is empty ON PURPOSE — the name is the very next
            // element, and a screen reader announcing it twice is noise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={identity.thumbUrl}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : null}
          <span className="text-base font-semibold">{identity.name}</span>
        </header>
      )}

      <div className="mx-auto w-full max-w-md p-4">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Make the layout a pass-through**

Replace the entire contents of `src/app/(widget)/layout.tsx` with:

```tsx
/**
 * Block 17a, spec §4.2. The widget's own frame — and it draws NO application
 * chrome at all: no navigation, no locale switcher, no footer, no Station name.
 * Everything this product usually puts around a page belongs to the product;
 * this page belongs to somebody else's website, and every pixel it adds is a
 * pixel a radio station's designer did not ask for.
 *
 * IT IS NOT A ROOT LAYOUT, and it cannot be. `src/app/layout.tsx` exists and
 * owns `<html>` and `<body>` for the whole application; a route group can only
 * take those over when EVERY group has its own root layout and there is no
 * `app/layout.tsx` at all.
 *
 * BLOCK 19b EMPTIED IT. Until then this file imposed a 28rem column and a
 * transparent `html,body` on every request under `/w`, which was right while
 * there was one presentation and wrong the moment there were two: a layout
 * cannot see `Sec-Fetch-Dest`, and it wraps the route whatever the route
 * decided. Both rules now live in `w/[publicKey]/frames.tsx`, chosen per
 * request by the page. What is left is the statement that this group adds
 * nothing — which is what the paragraph above always claimed it was.
 */
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```

- [ ] **Step 3: Wire the page**

In `src/app/(widget)/w/[publicKey]/page.tsx`, add to the imports:

```ts
import { headers } from 'next/headers';
import { choosePresentation } from '@/lib/widget/presentation';
import { installationExists, stationIdentity } from '@/services/widget-installations';
import { AppFrame, EmbeddedFrame } from './frames';
```

(the existing `import { installationExists } from '@/services/widget-installations';`
line is replaced by the one above).

Replace the final `return` — the `claims !== null ? … : …` expression at the end
of the function — with:

```tsx
  const body =
    claims !== null ? (
      <WidgetMenu publicKey={publicKey} initialOpen={parseOpenTarget(open, id)} />
    ) : (
      <IdentifyForm publicKey={publicKey} linkExpired={linkExpired} />
    );

  // D1: the frame around it, and the frame decides. `Sec-Fetch-Dest` is read
  // here rather than in the layout because a layout does not see the request.
  if (choosePresentation((await headers()).get('sec-fetch-dest')) === 'embedded') {
    return <EmbeddedFrame>{body}</EmbeddedFrame>;
  }

  // THE ONLY PLACE THE IDENTITY DOOR IS CALLED, and only after the decision:
  // an embedded widget — every widget on every Station's website — costs no
  // extra round trip for a header it will never draw.
  return <AppFrame identity={await stationIdentity(publicKey)}>{body}</AppFrame>;
```

Also move the `linkExpired` early return above (`if (linkExpired) return <IdentifyForm publicKey={publicKey} linkExpired />;`)
so it uses the same frames — replace that one line with:

```tsx
    // D3: a listener whose link died has no session by definition, and this is
    // the FIRST screen they see. Framing it as a 28rem transparent column in a
    // full tab is the exact complaint this block exists to answer, so it takes
    // the same decision the live page does — with no identity, because the key
    // resolves to nothing to be identified.
    if (linkExpired) {
      const expired = <IdentifyForm publicKey={publicKey} linkExpired />;
      return choosePresentation((await headers()).get('sec-fetch-dest')) === 'embedded' ? (
        <EmbeddedFrame>{expired}</EmbeddedFrame>
      ) : (
        <AppFrame identity={null}>{expired}</AppFrame>
      );
    }
```

- [ ] **Step 4: Verify it builds and typechecks**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: PASS all three.

- [ ] **Step 5: Look at both presentations by hand**

Run: `npm run dev`, then with a `publicKey` from a seeded installation open
`http://localhost:3000/w/<publicKey>` directly in a browser tab.
Expected: full-height screen, solid background, the Station's picture and name
in a bar at the top.

Then open the existing `tests/e2e/widget.spec.ts` fixture page, or any page that
frames the same URL in an `<iframe>`.
Expected: the narrow transparent column, with **no** header — unchanged from
before this block.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(widget)/layout.tsx" "src/app/(widget)/w/[publicKey]/frames.tsx" "src/app/(widget)/w/[publicKey]/page.tsx"
git commit -m "feat(19b): two presentations for one address, chosen by the frame"
```

---

## Task 5: The sign-out action

**Files:**
- Modify: `src/app/(widget)/w/[publicKey]/actions.ts` (add `signOutAction` after `verifyCodeAction`, before the `expireDeadSession` helper)
- Create: `tests/unit/widget-sign-out.test.ts`

**Interfaces:**
- Consumes: `WIDGET_SESSION_COOKIE` from `@/lib/widget/session`.
- Produces: `signOutAction(): Promise<void>` — a server action taking no arguments.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/widget-sign-out.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { get: vi.fn(), set: vi.fn() };
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

describe('signOutAction', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
  });

  it('clears the session cookie with the five attributes it was minted with', async () => {
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');
    await signOutAction();

    expect(cookieStore.set).toHaveBeenCalledWith('pw_session', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/w',
      maxAge: 0,
    });
  });

  it('clears it without reading, verifying or caring what was presented', async () => {
    // A listener whose token already expired still pressed "Sair", and they are
    // entitled to the same answer. Making the clear conditional on a valid
    // session is how a dead cookie survives the one interaction meant to remove
    // it — the defect `expireDeadSession` has to work around on every submit.
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');
    await signOutAction();

    expect(cookieStore.get).not.toHaveBeenCalled();
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/widget-sign-out.test.ts`
Expected: FAIL — `signOutAction` is not exported.

- [ ] **Step 3: Write the action**

In `src/app/(widget)/w/[publicKey]/actions.ts`, add after `verifyCodeAction` and
before the `expireDeadSession` helper:

```ts
/**
 * Block 19b, D4. "Sair": the listener is finished, and the session goes with
 * them.
 *
 * NOT `expireDeadSession`, WHICH IS ITS OPPOSITE. That helper clears a cookie
 * only once it has proved the token inside is already dead, so an ordinary
 * submission cannot log a listener out; this one clears unconditionally,
 * because being asked is the whole condition. A listener whose token expired
 * while they read the confirmation still pressed the button, and making the
 * clear depend on a token that verifies would leave them signed in on the one
 * interaction meant to sign them out.
 *
 * TAKES NO PUBLIC KEY, and there is nothing for one to do here. The cookie's
 * `Path` is `/w` — one cookie for every installation this deployment serves
 * (session.ts) — so there is no per-Station cookie to pick between, and a key
 * would only invite a caller to believe otherwise. Nothing is read, nothing is
 * written to the database, and no rate limit applies: the whole effect is one
 * `Set-Cookie` on the caller's own browser, which they could send themselves by
 * clearing it.
 *
 * THE SIX ATTRIBUTES MATCH THE MINT EXACTLY (verifyCodeAction, and
 * enter/route.ts, whose comments explain why each is load-bearing for a cookie
 * a third-party iframe has to receive). A browser matches a clear against
 * name, domain and PATH; `path: '/w'` omitted here would set a SECOND cookie at
 * `/` and leave the real one exactly where it was.
 */
export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(WIDGET_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    path: '/w',
    maxAge: 0,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/widget-sign-out.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(widget)/w/[publicKey]/actions.ts" tests/unit/widget-sign-out.test.ts
git commit -m "feat(19b): a listener can end their own session"
```

---

## Task 6: The exit button and the farewell

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/farewell.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/menu.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/request-song.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/page.tsx` (pass `exitHref` into `WidgetMenu`)
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: `signOutAction` (Task 5), `StationIdentity` (Task 2).
- Produces:
  - `<Farewell exitHref={string | null} />`
  - `WidgetMenu` gains `exitHref?: string | null`
  - `RequestSongPanel` and `EnterPromotionPanel` each gain `onExit: () => void`
  - `Shell` (private to each panel) gains `onExit?: () => void`

- [ ] **Step 1: Add the four keys to all three locale files**

In `messages/pt.json`, inside the `widget` object, after `"linkExpired"`:

```json
    "exit": "Sair",
    "goodbye": "Obrigado! Até a próxima.",
    "backToWhatsApp": "Voltar ao WhatsApp",
    "identifyAgainAction": "Identificar-me de novo"
```

In `messages/en.json`, same place:

```json
    "exit": "Exit",
    "goodbye": "Thank you! See you next time.",
    "backToWhatsApp": "Back to WhatsApp",
    "identifyAgainAction": "Identify me again"
```

In `messages/es.json`, same place:

```json
    "exit": "Salir",
    "goodbye": "¡Gracias! Hasta la próxima.",
    "backToWhatsApp": "Volver a WhatsApp",
    "identifyAgainAction": "Identificarme de nuevo"
```

`identifyAgainAction` and not `identifyAgain`: the latter already exists and is
a sentence explaining that a session ended ("Sua sessão terminou. Identifique-se
novamente."). Reusing it would put a paragraph on a button.

- [ ] **Step 2: Run the catalogue tests to verify all three agree**

Run: `npx vitest run tests/unit/i18n`
Expected: PASS. A key added to one file and missed in another fails here, which
is why this step comes before anything uses the keys.

- [ ] **Step 3: Write the farewell**

Create `src/app/(widget)/w/[publicKey]/farewell.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Block 19b, D5. What is left after "Sair": a thank-you, and the way back that
 * fits the door the listener came through.
 *
 * THE SESSION IS ALREADY GONE when this renders — `signOutAction` cleared the
 * cookie before the state that shows this panel was set. Nothing here reads it,
 * and a reload lands on the identify form, which is the truth.
 *
 * `exitHref` IS BOTH THE ADDRESS AND THE ANSWER TO "WHICH DOOR". It is non-null
 * only in the application presentation, and only for a Station whose WhatsApp
 * number is recorded — the embedded widget on a Station's own website never
 * reads the identity door at all, so it is null there by construction rather
 * than by a second flag that could disagree with the first.
 */
export function Farewell({ exitHref }: { exitHref: string | null }) {
  const t = useTranslations('widget');
  const router = useRouter();

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-farewell"
    >
      <p className="text-sm">{t('goodbye')}</p>

      {exitHref !== null ? (
        // A PLAIN ANCHOR, not a router push and not a `<Button>`: this address
        // leaves the application entirely, and `src/components/ui/button.tsx`
        // has no `asChild` — it is a bare `<button>` with variants, not a
        // Radix Slot, so it cannot lend its styling to an `<a>`. The classes
        // below are `variant="outline" size="default"` copied from that file.
        // `form-action 'self'` in csp.ts governs form submissions and does not
        // apply to a link, and no `navigate-to` directive is set — so this
        // needs no CSP change.
        <a
          href={exitHref}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="widget-back-to-whatsapp"
        >
          {t('backToWhatsApp')}
        </a>
      ) : (
        // The cookie is gone, so the server renders the identify form for this
        // same address. `refresh` rather than a state reset in the parent: the
        // parent is only rendered at all because the SERVER saw a session, and
        // asking it again is what makes the screen agree with the cookie.
        <Button
          type="button"
          variant="outline"
          onClick={() => router.refresh()}
          data-testid="widget-identify-again"
        >
          {t('identifyAgainAction')}
        </Button>
      )}
    </div>
  );
}
```

`Button` is imported for the second branch only. Confirmed 2026-08-12:
`src/components/ui/button.tsx` exports a plain `<button>` with `cva` variants
and has no `asChild`/`Slot`, which is why the first branch is a hand-classed
anchor rather than a `<Button>` wrapping one.

- [ ] **Step 4: Give the menu the exit, and the farewell a home**

In `src/app/(widget)/w/[publicKey]/menu.tsx`:

Add to the imports:

```ts
import { useState, useTransition } from 'react';
import { signOutAction } from './actions';
import { Farewell } from './farewell';
```

(the existing `import { useState } from 'react';` line is replaced.)

Add the prop to the signature, after `initialOpen`:

```ts
  /**
   * Block 19b. Where "Sair" sends a listener afterwards — `null` for the
   * embedded widget, which has no conversation to return to. Threaded from the
   * page rather than fetched here: this is a client component and the identity
   * door is read with the anon key on the server.
   */
  exitHref?: string | null;
```

and to the destructuring: `{ publicKey, initialOpen, exitHref = null }`.

Add the state and the handler, after the existing `useState` for `panel`:

```ts
  /**
   * ONE `left` FOR THE WHOLE WIDGET, held here rather than in each panel,
   * because "Sair" is reachable from three of them and the farewell that
   * follows is the same screen every time. A panel that owned its own copy
   * would have to be told to stop rendering by this component anyway.
   */
  const [left, setLeft] = useState(false);
  const [leaving, startLeaving] = useTransition();

  const exit = () => {
    // The action clears the cookie; `left` swaps the screen. In this order, and
    // inside a transition, so a second click during the round trip does nothing
    // rather than firing a second `Set-Cookie`.
    startLeaving(async () => {
      await signOutAction();
      setLeft(true);
    });
  };

  if (left) return <Farewell exitHref={exitHref} />;
```

Place `if (left) return …` **above** the existing `if (panel === 'promotion')`
branch, so leaving from inside a panel shows the farewell rather than the panel.

Pass the handler to both panels — the two existing branches become:

```tsx
  if (panel === 'promotion') {
    return (
      <EnterPromotionPanel
        publicKey={publicKey}
        onClose={() => setPanel('menu')}
        onExit={exit}
        autoOpenId={initialOpen?.kind === 'promotion' ? initialOpen.id : undefined}
      />
    );
  }

  if (panel === 'song') {
    return <RequestSongPanel publicKey={publicKey} onClose={() => setPanel('menu')} onExit={exit} />;
  }
```

(keep the existing comment block above `autoOpenId` untouched.)

And add the button to the menu's own markup, as a third child of the outer
`div`, **after** the `flex flex-col gap-2` div holding the two errands:

```tsx
      {/* D6. Below the two errands and separated from them: it is a way out,
          not a third thing to do. */}
      <Button
        type="button"
        variant="ghost"
        onClick={exit}
        disabled={leaving}
        className="self-start"
        data-testid="widget-exit"
      >
        {t('exit')}
      </Button>
```

- [ ] **Step 5: Give the music panel its exit**

In `src/app/(widget)/w/[publicKey]/request-song.tsx`:

Add `onExit` to the component's props — signature and destructuring both:

```ts
export function RequestSongPanel({
  publicKey,
  onClose,
  onExit,
}: {
  publicKey: string;
  onClose: () => void;
  /** Block 19b. Ends the session. Offered on the recorded screen alone — see Shell. */
  onExit: () => void;
}) {
```

Pass it through on the **recorded** branch only, leaving the other four `Shell`
usages exactly as they are:

```tsx
  if (requestState.status === 'recorded') {
    return (
      <Shell title={t('requestASong')} onClose={onClose} onExit={onExit}>
        <p className="text-sm" data-testid="widget-song-recorded">
          {t('requestRecorded')}
        </p>
      </Shell>
    );
  }
```

Then teach `Shell` about it — replace the whole `Shell` function at the bottom
of the file with:

```tsx
function Shell({
  title,
  onClose,
  onExit,
  children,
}: {
  title: string;
  onClose: () => void;
  /**
   * Block 19b, D6. Present only on the screen that ENDS an errand. A button
   * that discards the session, sitting under a half-typed search, is a way to
   * lose work — which is why this is a prop the caller opts into rather than
   * something this Shell draws for everybody.
   */
  onExit?: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('widget');

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-song-panel"
    >
      <h1 className="text-base font-semibold">{title}</h1>
      {children}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('back')}
        </Button>
        {onExit ? (
          <Button type="button" variant="ghost" onClick={onExit} data-testid="widget-exit">
            {t('exit')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

(the `self-start` on the old single button is replaced by the row, which is
already left-aligned inside a `flex-col`.)

- [ ] **Step 6: Give the promotion panel its exit**

In `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`, make the same three
changes:

Props:

```ts
  onExit,
```
```ts
  /** Block 19b. Ends the session. Offered on the settled screen alone — see Shell. */
  onExit: () => void;
```

The settled branch — **both** outcomes, since a declined entry ends the errand
just as a recorded one does:

```tsx
  if (state.status === 'entered' || state.status === 'declined') {
    return (
      <Shell title={t('enterAPromotion')} onClose={onClose} onExit={onExit}>
        <p className="text-sm" data-testid="widget-promotion-done">
          {state.status === 'entered' ? t('entryRecorded') : t('entryNotRecorded')}
        </p>
      </Shell>
    );
  }
```

And its `Shell` — same shape as the music panel's, with this file's own
`closeLabel` prop kept:

```tsx
function Shell({
  title,
  onClose,
  onExit,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  /**
   * Block 19b, D6. Present only on the screen that ENDS an errand — never
   * beside a half-filled promotion form, where a button that discards the
   * session sits next to the field being typed into.
   */
  onExit?: () => void;
  closeLabel?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('widget');

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-promotion-panel"
    >
      <h1 className="text-base font-semibold">{title}</h1>
      {children}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {closeLabel ?? t('back')}
        </Button>
        {onExit ? (
          <Button type="button" variant="ghost" onClick={onExit} data-testid="widget-exit">
            {t('exit')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

**Read the existing `Shell` first** — its exact prop list and markup are the
authority; the block above changes only the button row and adds `onExit`.

- [ ] **Step 7: Thread `exitHref` from the page**

In `src/app/(widget)/w/[publicKey]/page.tsx`, the identity is currently read
after the presentation decision. `WidgetMenu` needs it too, so hoist the read
above `body` and reuse it. Replace the block written in Task 4, step 3 with:

```tsx
  const presentation = choosePresentation((await headers()).get('sec-fetch-dest'));
  // Read ONCE, and only for the application: the header and the farewell's way
  // back are the same fact, and asking the door twice per request would be two
  // round trips to answer one question.
  const identity = presentation === 'app' ? await stationIdentity(publicKey) : null;

  const body =
    claims !== null ? (
      <WidgetMenu
        publicKey={publicKey}
        initialOpen={parseOpenTarget(open, id)}
        exitHref={identity?.whatsappHref ?? null}
      />
    ) : (
      <IdentifyForm publicKey={publicKey} linkExpired={linkExpired} />
    );

  return presentation === 'embedded' ? (
    <EmbeddedFrame>{body}</EmbeddedFrame>
  ) : (
    <AppFrame identity={identity}>{body}</AppFrame>
  );
```

- [ ] **Step 8: Verify the gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS all four.

- [ ] **Step 9: Walk it by hand**

Run `npm run dev`, open `/w/<publicKey>` in a tab, identify, request a song, and
press "Sair" on the confirmation.
Expected: the farewell, with "Voltar ao WhatsApp" when the seeded Station has a
WhatsApp integration with a number. Reload: the identify form.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(widget)/w/[publicKey]/farewell.tsx" "src/app/(widget)/w/[publicKey]/menu.tsx" "src/app/(widget)/w/[publicKey]/request-song.tsx" "src/app/(widget)/w/[publicKey]/enter-promotion.tsx" "src/app/(widget)/w/[publicKey]/page.tsx" messages/en.json messages/pt.json messages/es.json
git commit -m "feat(19b): Sair, and a goodbye that knows which door you came through"
```

---

## Task 7: The proof through the screen

**Files:**
- Modify: `tests/e2e/whatsapp-entry.spec.ts` (extend the existing journey test)
- Modify: `tests/e2e/widget.spec.ts` (add one test)
- Modify: `docs/WIDGET.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Assert the header on the WhatsApp journey**

In `tests/e2e/whatsapp-entry.spec.ts`, inside the existing test
`'a hashtag becomes a link, the link identifies, and the widget answers the open target it was minted for'`
(around line 361), after the assertion that follows `await page.goto(link)`
(around line 396) and the menu becoming visible, add:

```ts
  // Block 19b, D1/D2. THE PRESENTATION, ASSERTED FROM THE JOURNEY THAT
  // PRODUCES IT — not from a page.goto with a hand-set cookie, which would
  // prove the frame and skip the door. This navigation is a top-level one, so
  // Sec-Fetch-Dest is `document` and the page owes a header.
  await expect(page.getByTestId('widget-station-header')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('widget-station-header')).toContainText(stationName);
```

**Before writing it, find what the fixture calls the Station.** Run
`grep -n "provisionCustomer\|companyName\|stationName\|name:" tests/e2e/whatsapp-entry.spec.ts | head -20`
and use the variable that holds the provisioned Station's name; if the fixture
does not keep one, capture it where the customer is provisioned rather than
hard-coding a string.

- [ ] **Step 2: Assert the framed widget has no header**

In `tests/e2e/widget.spec.ts`, inside the existing test that identifies inside
the cross-origin iframe, after the menu becomes visible in the frame, add:

```ts
  // The counterpart to whatsapp-entry.spec.ts's assertion, and the pair is what
  // makes either one mean anything: the SAME address, framed, draws no header
  // and keeps the 28rem column a Station's designer laid out for.
  await expect(frame.getByTestId('widget-station-header')).toHaveCount(0);
```

Use whatever the surrounding test calls its `FrameLocator` (the file imports
`FrameLocator` from `@playwright/test`, so one exists).

- [ ] **Step 3: Add the exit journey**

In `tests/e2e/widget.spec.ts`, add a test after the identify journey. It reuses
that file's fixture and its cross-origin frame:

```ts
test('a listener who finishes an errand can leave, and the session leaves with them', async ({ page }) => {
  // Reaches the menu exactly as the identify journey above does — the same
  // fixture, the same frame, the same two steps. A test that set `pw_session`
  // itself would prove the button and skip everything that makes a session
  // real.
  // <-- reuse the identify steps from the test above, up to the menu being
  //     visible inside `frame`.

  await frame.getByTestId('widget-exit').click();
  await expect(frame.getByTestId('widget-farewell')).toBeVisible({ timeout: 30_000 });

  // NO WAY BACK TO A CONVERSATION FROM A STATION'S OWN WEBSITE: this listener
  // never came from WhatsApp, and the identity door was never read for a framed
  // request, so the farewell offers the other button.
  await expect(frame.getByTestId('widget-identify-again')).toBeVisible();
  await expect(frame.getByTestId('widget-back-to-whatsapp')).toHaveCount(0);

  // THE ASSERTION THAT MATTERS. The screen changing proves a state update; only
  // a reload proves the cookie is gone, because the server decides which of the
  // two states this page renders and it decides from the cookie alone.
  await page.reload();
  await expect(frame.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });
});
```

`widget-identify-form` is confirmed — `identify-form.tsx:249` carries it, and
`widget-link-expired` (line 165) and `widget-code-form` (line 201) are the other
two states of that same component, so the assertion cannot pass on the wrong one.

**One thing to resolve while writing it:** the identify steps are already in the
file. Extract them into a local helper rather than copying, if the existing
test's body makes that clean; a second verbatim copy of a two-step identify
flow is how the two come to disagree about what identifying means.

- [ ] **Step 4: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS, including the two files touched here. If a dev server from an
earlier step is still running on 3000, stop it first — a stale `next dev` serving
the pre-change bundle looks exactly like a regression.

- [ ] **Step 5: Document the two presentations**

In `docs/WIDGET.md`, add a section after whatever describes the widget's
embedding. Read the file's existing headings first and match them.

```markdown
## Two presentations, one address

`/w/<publicKey>` decides how to draw itself from the request's `Sec-Fetch-Dest`:

- **`iframe`** — the embedded widget: a 28rem column with a transparent
  background, so a Station's own page shows through around it. This is every
  widget on every Station's website, and it is unchanged since Block 17a.
- **anything else, including the header being absent** — the application: full
  height, its own background, larger touch targets, and a header carrying the
  Station's picture and name. This is what a listener sees after tapping the
  link a WhatsApp reply carried.

The header's picture is **the Station's picture** — the "Foto da emissora" of
the console's Station record (`companies.thumb_url`). A Station that has not
uploaded one gets the header with its name alone. There is no separate logo
field and none is planned.

Every screen that ends an errand, and the menu, offers **"Sair"**: it clears the
session cookie and shows a farewell. From the WhatsApp door the farewell offers
a way back to the conversation, built from the Station's own
`integrations.display_phone_number`; a Station whose number is not recorded gets
the farewell without that button. From a Station's website it offers to identify
again.
```

- [ ] **Step 6: Run every gate**

Run, in order:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run db:test
npm run test:e2e
npm run test:isolation
```

Expected: all seven pass. Report the actual counts, not "tests pass".

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/whatsapp-entry.spec.ts tests/e2e/widget.spec.ts docs/WIDGET.md
git commit -m "test(19b): the header, its absence when framed, and the way out"
```

---

## Self-Review

**Spec coverage.** D1 → Task 3 and Task 4. D2 → Task 1 (the column read) and
Task 4 (the round picture). D3 → Task 4, step 3's `linkExpired` branch. D4 →
Task 5. D5 → Task 6's `Farewell`. D6 → Task 6, steps 4–6. §5's door → Task 1.
§6's frames → Task 4; §6's exit → Task 6. §7's five cases: no picture and no
number are Task 1's fixtures and Task 2's parser; an unreachable door is Task 2's
`return null`; the two reload rows are Task 7's assertions. §8's three test
groups → Tasks 1, 2, 3, 5, 7.

**One gap accepted, not overlooked.** §8 asks for a unit test of the
presentation decision over four `Sec-Fetch-Dest` values, which Task 3 has; it
does not ask for one over the frames themselves, and Task 4 therefore ships with
`npm run build` and Task 7's e2e as its only gates. That is deliberate — a test
asserting that `AppFrame` emits a `<style>` element would pin this task's markup
rather than its behaviour, and would have to be rewritten by anybody who
adjusted the padding.

**Type consistency.** `StationIdentity` is declared once (Task 2,
`src/lib/widget/station-identity.ts`) and re-exported from the service so Task 4
and Task 6 import it from one place. `whatsappHref` is the function in Task 2
and the *field name* on `StationIdentity`; the field is what Task 6 threads as
`exitHref`, and the rename happens exactly once, at the `WidgetMenu` call site
in Task 6, step 7. `choosePresentation` returns `'embedded' | 'app'` and every
comparison in Task 4 and Task 6 is against those two literals.

**Two unknowns were settled while writing this plan rather than delegated.**
`Button` has no `asChild`, so Task 6's farewell uses a hand-classed anchor and
says why; `widget-identify-form` exists at `identify-form.tsx:249`, so Task 7's
reload assertion is exact. What remains as "check the file first" is Task 7,
steps 1–3: the e2e fixtures' own local variable names, which belong to tests
this plan does not otherwise touch, and each comes with the exact command that
settles it.
