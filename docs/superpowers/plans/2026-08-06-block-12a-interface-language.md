# Block 12a — The Interface Speaks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take every user-facing sentence out of the components and into a message catalogue, and build the machinery that decides which language to render — without changing a single pixel.

**Architecture:** `next-intl` resolves the locale per request from a cookie. The middleware, which already loads `profiles` on every request, keeps that cookie in step with `profiles.locale`, so rendering costs no extra query and the profile remains the choice that follows the person between browsers. Every screen reads its text from `messages/en.json`; nothing else about the screens changes.

**Tech Stack:** Next 15 App Router, `next-intl`, Supabase/Postgres, Vitest, pgTAP, Playwright.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-06-block-12a-interface-language-design.md`. Decisions cited as D1–D8.
- **Branch:** `block-12a`, already created from `main`. PR base is `main`.
- **Migration:** `0135`, and nothing else. **Never edited after it is pushed.**
- **Language:** code, comments, catalogue keys, tests and commit messages in English. The catalogue's *values* in this block are the English sentences already on screen.
- **D1 is absolute: text the user can edit inside the product is never touched.** Not templates, not system messages, not role names, not any name they typed.
- **No pixel moves.** The 44 Playwright journeys assert roughly a hundred visible strings; they must pass **unedited**. Editing a selector to make a journey pass is a finding, not a fix.
- **The date format does not change in this block** (D5) — it ships in 12b.
- `npm run db:test` needs a freshly reset database; `supabase db reset` leaves Kong blind until `docker restart supabase_kong_CRM_-_LISTENER`.
- **Never edit files under `src/` while a Playwright run is in progress** — the dev server recompiles and drops whatever test is mid-flight.

---

## File Structure

**Created:**
- `src/i18n/request.ts` — `getRequestConfig`: reads the cookie, loads the catalogue.
- `src/i18n/locales.ts` — the three locale codes, `AVAILABLE_LOCALES`, and `resolveLocale()`, a pure function with no Next imports so it can be unit-tested.
- `messages/en.json` — the catalogue. One top-level namespace per screen or shared area.
- `src/components/layout/locale-selector.tsx` — the control, gated by `AVAILABLE_LOCALES`.
- `src/app/(app)/locale-actions.ts` — the Server Action that records a choice.
- `supabase/migrations/0135_profile_locale.sql`, `supabase/tests/27_profile_locale.test.sql`
- `tests/unit/i18n/resolve-locale.test.ts`, `tests/unit/i18n/catalogue.test.ts`
- `tests/isolation/profile-locale.test.ts`
- `scripts/measure-db-messages.mjs` — the D7 measurement.

**Modified:**
- `next.config.mjs` — the `next-intl` plugin.
- `src/app/layout.tsx` — the provider, and `lang` on `<html>`.
- `src/middleware.ts` — read `locale`, keep the cookie in step.
- `package.json` — one dependency.
- Every screen, component, `actions.ts` and `errors.ts` that renders a sentence (Tasks 6–12).

---

## Task 1: `0135` — the column, and the grant nobody gets for free

**Files:**
- Create: `supabase/migrations/0135_profile_locale.sql`, `supabase/tests/27_profile_locale.test.sql`

**Interfaces:**
- Produces: `public.profiles.locale`, nullable, one of `'en' | 'pt' | 'es'`.

- [ ] **Step 1: Write the failing pgTAP test**

```sql
-- supabase/tests/27_profile_locale.test.sql
begin;
select plan(6);

-- Block 12a, D2. The interface language a person chose, which follows them to
-- any browser. NULL means they never chose -- the cookie and then the browser
-- decide, and finally English.

select has_column('public', 'profiles', 'locale', 'profiles.locale exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'profiles' and column_name = 'locale') = 'YES',
  'locale is nullable -- null means the person never chose');

-- The three, and only the three.
--
-- Asserted on the constraint's definition rather than by inserting a row:
-- profiles.id references auth.users (0003), so a made-up id fails on the
-- foreign key and an insert-based test would pass for the wrong reason,
-- reporting a check constraint that might not exist at all.
select ok(
  exists (
    select 1 from pg_constraint
     where conname = 'profiles_locale_supported'
       and pg_get_constraintdef(oid) like '%''en''%'
       and pg_get_constraintdef(oid) like '%''pt''%'
       and pg_get_constraintdef(oid) like '%''es''%'),
  'the constraint names exactly the three supported locales');

select col_has_check('public', 'profiles', 'locale',
  'locale carries a check constraint rather than accepting any string');

-- THE GRANT, and this file exists mostly for these two.
--
-- `grant update (full_name) on public.profiles to authenticated` (0006) is
-- COLUMN-SCOPED. A new column on this table is not writable by anybody until
-- it is named, and the failure is a silent no-op: the Server Action reports
-- success and the choice does not persist.
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'locale', 'update'),
  'a signed-in caller may write their own locale');

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'update'),
  'and still may not write the columns that gate their own account');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — column `locale` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0135_profile_locale.sql
--
-- Block 12a, D2. The interface language, chosen by the person reading.
--
-- NULL means "never chose", which is different from "chose English": the
-- resolution order is profile, then this browser's cookie, then what the
-- browser asks for, then English. A default of 'en' here would swallow the
-- middle two before they were ever consulted.
alter table public.profiles
  add column locale text
  constraint profiles_locale_supported check (locale in ('en', 'pt', 'es'));

comment on column public.profiles.locale is
  'Block 12a. The interface language this person chose, which follows them to any browser. NULL means they never chose. It governs what they READ and nothing else -- no stored value is ever rewritten because somebody switched language (D1).';

-- The grant is column-scoped on this table (0006 grants update (full_name)
-- only), so a new column is writable by nobody until it is named here. Without
-- this line the Server Action reports success and the choice does not persist
-- -- an update that matches no column is not an error, it is zero rows.
--
-- Only this column: must_change_password and provisional_expires_at gate the
-- account and stay unwritable by the account they gate.
grant update (locale) on public.profiles to authenticated;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && docker restart supabase_kong_CRM_-_LISTENER && npm run db:test`
Expected: PASS — `27_profile_locale` 6 of 6.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0135_profile_locale.sql supabase/tests/27_profile_locale.test.sql
git commit -m "feat(i18n): the interface language a person chose, and the column grant nobody gets for free"
```

---

## Task 2: The resolution order, as a pure function

**Files:**
- Create: `src/i18n/locales.ts`, `tests/unit/i18n/resolve-locale.test.ts`

**Interfaces:**
- Produces:
  - `type Locale = 'en' | 'pt' | 'es'`
  - `SUPPORTED_LOCALES: readonly Locale[]` — all three, always.
  - `AVAILABLE_LOCALES: readonly Locale[]` — the ones a person may choose today. `['en']` in this block (D4).
  - `DEFAULT_LOCALE: Locale` — `'en'`.
  - `isLocale(value: string | undefined | null): value is Locale`
  - `resolveLocale(input: { profile?: string | null; cookie?: string | null; acceptLanguage?: string | null }): Locale`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/i18n/resolve-locale.test.ts
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, isLocale, resolveLocale } from '@/i18n/locales';

describe('the resolution order', () => {
  it('prefers the profile, which follows the person between browsers', () => {
    expect(resolveLocale({ profile: 'pt', cookie: 'es', acceptLanguage: 'en-US' })).toBe('pt');
  });

  it('falls to the cookie, which is all anybody has before signing in', () => {
    expect(resolveLocale({ cookie: 'es', acceptLanguage: 'en-US' })).toBe('es');
  });

  it('falls to what the browser asks for', () => {
    expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt');
  });

  it('reads a quality-ordered header rather than taking the first token', () => {
    // "I prefer French, but Spanish will do." French is not offered, so the
    // answer is Spanish -- not English, and not French.
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9,es;q=0.7' })).toBe('es');
  });

  it('ends at English when nothing says otherwise', () => {
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ acceptLanguage: 'ja-JP,ja;q=0.9' })).toBe('en');
  });

  it('ignores a value that is not one of the three', () => {
    // A cookie is client-writable. "jp" in it must not reach the catalogue
    // loader as a filename.
    expect(resolveLocale({ profile: 'jp', cookie: 'zz' })).toBe('en');
  });

  it('knows what a locale is', () => {
    expect(isLocale('pt')).toBe(true);
    expect(isLocale('jp')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('offers only English while the other catalogues do not exist', () => {
    // D4: the selector renders nothing until there is something to select, so
    // nobody ever picks "Português" and receives English.
    expect([...AVAILABLE_LOCALES]).toEqual(['en']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/i18n/resolve-locale.test.ts`
Expected: FAIL — `Cannot find module '@/i18n/locales'`.

- [ ] **Step 3: Write it**

```ts
// src/i18n/locales.ts

/**
 * Block 12a, D2. Which language a person reads, and how that is decided.
 *
 * Deliberately free of Next imports: this is the one piece of the resolution
 * that can be asserted directly, and everything above it (the request config,
 * the middleware, the Server Action) is plumbing around this function.
 */
export type Locale = 'en' | 'pt' | 'es';

/** Every locale the product will ever offer. Matches the check constraint in 0135. */
export const SUPPORTED_LOCALES = ['en', 'pt', 'es'] as const satisfies readonly Locale[];

/**
 * The ones a person may choose TODAY.
 *
 * Block 12a ships the machinery and the English catalogue, so this holds one
 * entry and the selector renders nothing. Block 12b adds the other two
 * catalogues and opens it. That is what keeps anybody from choosing
 * "Português" and being handed English (D4).
 */
export const AVAILABLE_LOCALES = ['en'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Profile, then cookie, then the browser, then English.
 *
 * Every input is untrusted -- the cookie is client-writable and the header is
 * whatever was sent -- so anything that is not one of the three is discarded
 * rather than passed on. A locale reaches a filename downstream.
 */
export function resolveLocale(input: {
  profile?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.profile)) return input.profile;
  if (isLocale(input.cookie)) return input.cookie;

  const fromBrowser = preferredFromHeader(input.acceptLanguage);
  if (fromBrowser) return fromBrowser;

  return DEFAULT_LOCALE;
}

/**
 * Reads Accept-Language by QUALITY, not by position. "fr-FR,fr;q=0.9,es;q=0.7"
 * means "French, or Spanish if you must" -- answering English there ignores a
 * preference the browser stated plainly.
 */
function preferredFromHeader(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return {
        // pt-BR and pt are the same catalogue; the region does not choose one.
        base: (tag ?? '').trim().toLowerCase().split('-')[0] ?? '',
        quality: q ? Number.parseFloat(q.split('=')[1] ?? '0') : 1,
      };
    })
    .filter((entry) => entry.base.length > 0 && Number.isFinite(entry.quality))
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (isLocale(entry.base)) return entry.base;
  }
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/i18n/resolve-locale.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/locales.ts tests/unit/i18n/resolve-locale.test.ts
git commit -m "feat(i18n): profile, then cookie, then the browser, then English"
```

---

## Task 3: Wire `next-intl`, with the catalogue holding one key

**Files:**
- Create: `src/i18n/request.ts`, `messages/en.json`
- Modify: `next.config.mjs`, `src/app/layout.tsx`, `package.json`

**Interfaces:**
- Consumes: `resolveLocale`, `Locale` from Task 2.
- Produces: `getTranslations` / `useTranslations` usable anywhere; `<html lang>` reflecting the resolved locale.

- [ ] **Step 1: Install**

```bash
npm install next-intl
```

- [ ] **Step 2: Create the catalogue with the one key the layout needs**

```json
{
  "app": {
    "title": "PulchatX",
    "description": "CRM for entertainment companies"
  }
}
```

Save as `messages/en.json`. Tasks 6–12 fill it; the namespaces are one per screen
or shared area (`shell`, `login`, `members`, `inventory`, …).

- [ ] **Step 3: Write the request config**

```ts
// src/i18n/request.ts
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { resolveLocale, type Locale } from './locales';

/**
 * Block 12a, D2. What language this request is rendered in.
 *
 * It reads the COOKIE and never the profile, and that is not a shortcut: the
 * middleware (src/middleware.ts) already loads the profile row on every request
 * to check must_change_password, and writes the cookie from it. Asking the
 * database again here would be a second round trip on every render to learn
 * something the middleware knew a moment ago.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  const locale: Locale = resolveLocale({
    cookie: cookieStore.get('locale')?.value,
    acceptLanguage: headerList.get('accept-language'),
  });

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

- [ ] **Step 4: Register the plugin**

At the top of `next.config.mjs`:

```js
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
```

and change the final line from `export default nextConfig;` to:

```js
export default withNextIntl(nextConfig);
```

- [ ] **Step 5: Provide it to the tree**

Replace `src/app/layout.tsx` with:

```tsx
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('title'), description: t('description') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Block 12a. `lang` is not decoration: it is what a screen reader uses to
  // choose a voice, and what a browser uses to offer a translation.
  const locale = await getLocale();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Verify nothing moved**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: clean. **`/_not-found` becomes dynamic** — the layout now reads cookies,
so no route is prerendered any more. That is expected and is the last static
route the product had.

Run: `npx playwright test tests/e2e/home.spec.ts tests/e2e/headers.spec.ts tests/e2e/csp.spec.ts`
Expected: PASS, unedited.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json next.config.mjs src/app/layout.tsx src/i18n/request.ts messages/en.json
git commit -m "feat(i18n): resolve the language per request, from the cookie the middleware keeps"
```

---

## Task 4: The middleware keeps the cookie in step with the profile

**Files:**
- Modify: `src/middleware.ts`
- Create: `tests/unit/i18n/cookie-sync.test.ts`

**Interfaces:**
- Consumes: `resolveLocale`, `isLocale` from Task 2.
- Produces: `localeCookieUpdate(input: { profile?: string | null; cookie?: string | null }): Locale | null` in `src/i18n/locales.ts` — the value the cookie should be rewritten to, or `null` to leave it alone.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/i18n/cookie-sync.test.ts
import { describe, expect, it } from 'vitest';
import { localeCookieUpdate } from '@/i18n/locales';

describe('keeping the cookie in step with the profile', () => {
  it('writes the profile choice into a browser that has not heard it', () => {
    expect(localeCookieUpdate({ profile: 'pt', cookie: null })).toBe('pt');
  });

  it('corrects a browser that disagrees', () => {
    // The profile is the choice that travels with the person; the cookie is
    // just this browser's memory of it, so the profile wins.
    expect(localeCookieUpdate({ profile: 'pt', cookie: 'es' })).toBe('pt');
  });

  it('writes nothing when they already agree', () => {
    // Rewriting an identical cookie on every request would put a Set-Cookie on
    // every response in the product for no reason.
    expect(localeCookieUpdate({ profile: 'pt', cookie: 'pt' })).toBeNull();
  });

  it('leaves the cookie alone when the person never chose', () => {
    // A null profile is not a preference for English -- the cookie may hold a
    // choice made before signing in, and it outranks the browser header.
    expect(localeCookieUpdate({ profile: null, cookie: 'es' })).toBeNull();
    expect(localeCookieUpdate({ profile: null, cookie: null })).toBeNull();
  });

  it('ignores a profile value that is not a locale', () => {
    expect(localeCookieUpdate({ profile: 'jp', cookie: 'en' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/i18n/cookie-sync.test.ts`
Expected: FAIL — `localeCookieUpdate` is not exported.

- [ ] **Step 3: Add it to `src/i18n/locales.ts`**

```ts
/**
 * What the browser's cookie should become, or null to leave it alone.
 *
 * The profile is the choice that travels with the person; the cookie is one
 * browser's memory of it. When they disagree the profile wins -- but a person
 * who never chose has no opinion to impose, and their cookie may hold a choice
 * made before they signed in.
 */
export function localeCookieUpdate(input: {
  profile?: string | null;
  cookie?: string | null;
}): Locale | null {
  if (!isLocale(input.profile)) return null;
  if (input.cookie === input.profile) return null;
  return input.profile;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/i18n/cookie-sync.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in the middleware**

In `src/middleware.ts`, add to the imports:

```ts
import { localeCookieUpdate } from '@/i18n/locales';
```

Change the profile query (around line 102) to fetch the column as well:

```ts
  const { data: profile } = await supabase
    .from('profiles')
    .select('must_change_password, provisional_expires_at, locale')
    .eq('id', user.id)
    .single();

  // Block 12a, D2. The profile is the choice that follows this person between
  // browsers; the cookie is what rendering actually reads. Synchronised HERE
  // because this is the one place that already holds both -- the row was
  // loaded for must_change_password above, so the language costs no query at
  // all, and src/i18n/request.ts can then read a cookie and stop.
  const cookieLocale = localeCookieUpdate({
    profile: profile?.locale,
    cookie: request.cookies.get('locale')?.value,
  });
  if (cookieLocale) {
    response.cookies.set('locale', cookieLocale, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  }
```

**Place it immediately after the query and before the `must_change_password`
branches**, so a person being redirected to `/change-password` still arrives
there in their own language.

- [ ] **Step 6: Regenerate the types and verify**

Run: `npm run db:types && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/i18n/locales.ts tests/unit/i18n/cookie-sync.test.ts src/lib/supabase/database.types.ts
git commit -m "feat(i18n): the middleware keeps the cookie in step, on the query it already made"
```

---

## Task 5: Recording a choice

**Files:**
- Create: `src/app/(app)/locale-actions.ts`, `src/components/layout/locale-selector.tsx`, `tests/isolation/profile-locale.test.ts`
- Modify: `src/components/layout/app-shell.tsx`

**Interfaces:**
- Consumes: `AVAILABLE_LOCALES`, `isLocale`, `Locale` from Task 2.
- Produces: `setLocaleAction(formData: FormData): Promise<void>`; `<LocaleSelector current={locale} />`.

- [ ] **Step 1: Write the failing isolation test**

```ts
// tests/isolation/profile-locale.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 12a. The language a person may set is their own, and only their own.
 *
 * pgTAP asserts the grant exists; only this can assert the POLICY -- it runs as
 * superuser with a null auth.uid() and never exercises RLS at all.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const stamp = Date.now();
const mineEmail = `locale-mine-${stamp}@example.test`;
const theirsEmail = `locale-theirs-${stamp}@example.test`;
const password = `Locale-${stamp}-pw`;

let mine: SupabaseClient;
let theirsId = '';

async function makeUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  await admin.from('profiles').insert({ id: data.user.id, email });
  return data.user.id;
}

beforeAll(async () => {
  const mineId = await makeUser(mineEmail);
  theirsId = await makeUser(theirsEmail);

  mine = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await mine.auth.signInWithPassword({ email: mineEmail, password });
  if (error) throw new Error(`sign in: ${error.message}`);
  expect(mineId).toBeTruthy();
}, 60_000);

describe('Block 12a — the interface language is the reader\'s own', () => {
  it('a signed-in caller sets their own language', async () => {
    const { error } = await mine.from('profiles').update({ locale: 'pt' }).eq('id', (await mine.auth.getUser()).data.user?.id as string);
    expect(error, error?.message).toBeNull();

    const { data } = await admin.from('profiles').select('locale').eq('email', mineEmail).single();
    expect(data?.locale).toBe('pt');
  }, 60_000);

  it('and cannot set anybody else\'s', async () => {
    // RLS answers this, not the application: profiles_update_self (0006).
    // The update matches no row rather than raising, so the assertion is on
    // the OTHER row's value -- a silent no-op is exactly the failure mode.
    await mine.from('profiles').update({ locale: 'es' }).eq('id', theirsId);

    const { data } = await admin.from('profiles').select('locale').eq('id', theirsId).single();
    expect(data?.locale, 'one account changed another account\'s language').toBeNull();
  }, 60_000);

  it('and cannot smuggle another column in beside it', async () => {
    // The grant is column-scoped (0135). must_change_password gates the
    // account, and the account it gates may not write it.
    const { error } = await mine
      .from('profiles')
      .update({ locale: 'es', must_change_password: false })
      .eq('id', (await mine.auth.getUser()).data.user?.id as string);

    expect(error, 'a column-scoped grant let an ungranted column through').not.toBeNull();
  }, 60_000);
});
```

- [ ] **Step 2: Run it and watch the third case fail if the grant is wrong**

Run: `npx vitest run --config vitest.isolation.config.ts tests/isolation/profile-locale.test.ts`
Expected: PASS once `0135` is applied. If the third case fails, the grant in Task 1 named too much.

- [ ] **Step 3: Write the Server Action**

```ts
// src/app/(app)/locale-actions.ts
'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { AVAILABLE_LOCALES, isLocale } from '@/i18n/locales';

/**
 * Block 12a, D2. Records a language choice in both places it has to live: the
 * profile, which follows the person to any browser, and the cookie, which is
 * what rendering actually reads.
 *
 * The cookie is written even when the profile write fails, and that order is
 * deliberate: somebody who is not signed in has no profile, and somebody whose
 * profile write failed should still get the language they just asked for.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const chosen = formData.get('locale');
  if (typeof chosen !== 'string' || !isLocale(chosen)) return;
  // Refuse a language the product cannot render yet, however it was submitted.
  if (!(AVAILABLE_LOCALES as readonly string[]).includes(chosen)) return;

  const store = await cookies();
  store.set('locale', chosen, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });

  try {
    const supabase = await createUserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const { error } = await supabase
        .from('profiles')
        .update({ locale: chosen })
        .eq('id', data.user.id);
      if (error) throw new Error(error.message);
    }
  } catch (cause) {
    // The cookie is already set, so the person gets what they asked for in this
    // browser; what is lost is the choice following them elsewhere.
    logger.error({ err: cause }, 'could not persist the locale choice to the profile');
  }

  revalidatePath('/', 'layout');
}
```

- [ ] **Step 4: Write the selector**

```tsx
// src/components/layout/locale-selector.tsx
import { AVAILABLE_LOCALES, type Locale } from '@/i18n/locales';
import { setLocaleAction } from '@/app/(app)/locale-actions';

const LOCALE_NAMES: Record<Locale, string> = {
  // Each in its own language, which is how a person finds theirs in a list.
  en: 'English',
  pt: 'Português',
  es: 'Español',
};

/**
 * Block 12a, D4. Renders NOTHING while only one language exists.
 *
 * A control offering "Português" before the Portuguese catalogue is written
 * would hand somebody English and call it their choice. AVAILABLE_LOCALES opens
 * in Block 12b and this appears with it -- no other change required.
 */
export function LocaleSelector({ current }: { current: Locale }) {
  if (AVAILABLE_LOCALES.length < 2) return null;

  return (
    <form action={setLocaleAction} className="px-3 py-2">
      <label className="flex flex-col gap-1 text-xs text-sidebar-muted">
        <span>Language</span>
        <select
          name="locale"
          defaultValue={current}
          data-testid="locale-selector"
          className="rounded border bg-transparent px-2 py-1 text-sm text-white"
        >
          {AVAILABLE_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="mt-1 text-xs underline" data-testid="locale-save">
        Save
      </button>
    </form>
  );
}
```

**The two English strings above (`Language`, `Save`) are placed into
`messages/en.json` under the `shell` namespace in Task 6** — this file is written
before the catalogue exists, and Task 6 is where it joins it.

- [ ] **Step 5: Mount it in the shell**

In `src/components/layout/app-shell.tsx`, immediately after the block that
renders the user's name and role (around line 102), add:

```tsx
            <LocaleSelector current={locale} />
```

with `import { LocaleSelector } from './locale-selector';` and the shell taking
`locale` from `await getLocale()` if it is a Server Component, or as a prop from
its caller if it is not. **Read the file before editing to see which it is.**

- [ ] **Step 6: Verify nothing rendered**

Run: `npm run lint && npm run typecheck && npx playwright test tests/e2e/dashboards.spec.ts`
Expected: clean and PASS. The selector renders nothing, so no journey sees a
change.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/locale-actions.ts" src/components/layout/locale-selector.tsx src/components/layout/app-shell.tsx tests/isolation/profile-locale.test.ts
git commit -m "feat(i18n): record a language choice, in both places it has to live"
```

---

## Tasks 6–12: Externalisation, one area at a time

**The method is identical in each and is written out once here.** Each task
takes one area, moves its sentences into `messages/en.json`, and ends with the
journeys covering that area passing **unedited**.

**The method:**

1. **Namespace per area**, top level in `messages/en.json`: `shell`, `auth`,
   `admin`, `members`, `inventory`, `promotions`, `music`, `reports`.
   Nest by screen below that (`members.list.title`, `members.register.submit`).
2. **Server Component:** `const t = await getTranslations('members');` then
   `{t('list.title')}`.
3. **Client Component:** `const t = useTranslations('members');` — same keys.
4. **Server Action / `errors.ts`:** these are the awkward ones. The mappers are
   synchronous today and several return `cause.message` untouched (D7). **Make
   the mapper `async` and call `getTranslations` inside it**, leaving the
   pass-through branches exactly as they are. Call sites gain an `await`.
5. **Plurals:** wherever the code writes `(s)`, use ICU:
   `"units": "{count, plural, one {# unit} other {# units}}"`. There are 18 of
   them and they are the only places where the English wording may change —
   `1 unit` instead of `1 unit(s)` is the intended improvement, and any journey
   asserting the old string is a journey to check by hand rather than edit
   blindly.
6. **Never touch** a string that is a value the user typed, a template, a system
   message, a role name, a `data-testid`, a route, a column name, an RPC name, a
   permission code or an audit action code (D1).

**The verification for every one of these tasks:**

```bash
npm run lint && npm run typecheck && npm run build
npx playwright test <the journeys covering this area> --workers=1
```

Expected: PASS, **with no edit to any journey**. A failing assertion is a word
that was dropped or changed — fix the catalogue, not the test.

| task | area | files | journeys that must pass unedited |
| --- | --- | --- | --- |
| **6** | `shell`, and the two strings from Task 5 | `src/components/layout/*` | `dashboards`, `home` |
| **7** | `auth` — login, change password, forgot, invite | `src/app/(auth)/**`, `src/app/(public)/**` | `provisioning-flow`, `invitation-flow`, `home` |
| **8** | `admin` — customers, contact requests, integrations | `src/app/(admin)/**` | `provisioning-flow`, `audit` |
| **9** | `members` — listeners, participations | `src/app/(app)/members/**`, `src/app/(app)/participations/**` | `members-flow`, `participations-flow`, `record-dialog` |
| **10** | `inventory` — prizes, stock, movements | `src/app/(app)/inventory/**` | `inventory-flow` |
| **11** | `promotions` — promotions, draws, pickups, deadlines | `src/app/(app)/promotions/**`, `src/app/(app)/pickups/**`, `src/components/draws/**` | `promotions-flow`, `promotion-prizes`, `draw-flow`, `filtered-draw`, `delivery-flow`, `deadline` |
| **12** | `music`, `reports`, `templates`, `dashboards`, `audit` | the remaining `src/app/(app)/**` | `music-catalogue`, `music-requests`, `reports`, `templates`, `dashboards`, `audit` |

Commit after each with `refactor(i18n): move the <area> text into the catalogue`.

**Run `acceptance.spec.ts` after Task 12** — it walks fifteen screens and is the
one journey that would catch a namespace collision between areas.

### Task 11 also: `formatInstant` learns the language, and keeps today's output

`src/app/(app)/promotions/format.ts` is in Task 11's area, and this is the one
piece of D5 that belongs in this block.

- [ ] **Step A: Write the failing test**

```ts
// tests/unit/i18n/format-instant.test.ts
import { describe, expect, it } from 'vitest';
import { formatInstant } from '@/app/(app)/promotions/format';

const INSTANT = '2026-08-06T17:30:00.000Z';
const ZONE = 'America/Sao_Paulo';

describe('formatInstant', () => {
  it('renders English exactly as it did before this block', () => {
    // Block 12a, D5. The format follows the language only from Block 12b; here
    // the English rendering must be byte-identical to what shipped, because
    // this block promises nothing on screen moves -- and today's hardcoded
    // en-GB writes day/month while the English locale writes month/day.
    expect(formatInstant(INSTANT, ZONE, 'en')).toBe('06/08/2026, 14:30');
  });

  it('keeps the Station zone whatever the language', () => {
    // The correctness property Block 6a paid for: an operator elsewhere must
    // not read a draw as having happened an hour from when it ran.
    expect(formatInstant(INSTANT, 'UTC', 'en')).toBe('06/08/2026, 17:30');
  });
});
```

- [ ] **Step B: Run it and watch it fail**

Run: `npx vitest run tests/unit/i18n/format-instant.test.ts`
Expected: FAIL — `formatInstant` takes two arguments.

- [ ] **Step C: Add the parameter**

In `src/app/(app)/promotions/format.ts`:

```ts
/**
 * Block 12a, D5. The language is a parameter now, and in this block every
 * caller passes 'en' and gets exactly what shipped before.
 *
 * DELIBERATELY NOT `Intl.DateTimeFormat(locale, …)` yet: today's hardcoded
 * 'en-GB' writes day/month and the English locale writes month/day, so wiring
 * it through here would flip every date in the product into American order in
 * a block whose whole promise is that nothing on screen moves. Block 12b makes
 * the mapping real, alongside the languages that give it a reason.
 */
const FORMAT_LOCALE: Record<Locale, string> = {
  en: 'en-GB',
  pt: 'en-GB',
  es: 'en-GB',
};

export function formatInstant(instant: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(FORMAT_LOCALE[locale], {
    // ...the existing options, unchanged...
    timeZone,
  }).format(new Date(instant));
}
```

with `import type { Locale } from '@/i18n/locales';`.

- [ ] **Step D: Update every caller**

Run: `grep -rn "formatInstant(" src --include=*.tsx --include=*.ts`
Each caller passes the locale it already has — `await getLocale()` in a Server
Component, `useLocale()` in a Client Component.

- [ ] **Step E: Verify**

Run: `npx vitest run tests/unit/i18n/format-instant.test.ts && npm run typecheck`
Expected: PASS and clean.

---

## Task 13: The two guards

**Files:**
- Create: `tests/unit/i18n/catalogue.test.ts`
- Modify: `.eslintrc.json` (or whatever the project's ESLint config file is — read it first)

**Interfaces:**
- Consumes: `SUPPORTED_LOCALES`, `AVAILABLE_LOCALES` from Task 2.

- [ ] **Step 1: Write the key-parity test**

```ts
// tests/unit/i18n/catalogue.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '@/i18n/locales';

/**
 * Block 12a, D8. What stops a translation from being quietly incomplete.
 *
 * In this block it guards one catalogue and looks like ceremony. In Block 12b
 * it is the only thing standing between "we translated it" and a Spanish screen
 * with three English sentences on it that nobody noticed.
 */
const DIRECTORY = join(process.cwd(), 'messages');

function keysOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIRECTORY, `${locale}.json`), 'utf8'));
}

describe('the message catalogues', () => {
  it('has a file for every language the product offers', () => {
    const present = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace('.json', ''))
      .sort();
    expect(present).toEqual([...AVAILABLE_LOCALES].sort());
  });

  it('holds exactly the same keys in every language', () => {
    const reference = keysOf(load(DEFAULT_LOCALE)).sort();
    for (const locale of AVAILABLE_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const theirs = keysOf(load(locale)).sort();
      expect(theirs, `${locale}.json does not match ${DEFAULT_LOCALE}.json`).toEqual(reference);
    }
  });

  it('has no empty value anywhere', () => {
    // An empty string passes a key-parity check and renders as nothing at all,
    // which on screen is indistinguishable from a bug in the component.
    for (const locale of AVAILABLE_LOCALES) {
      const flat = JSON.stringify(load(locale));
      expect(flat, `${locale}.json holds an empty value`).not.toMatch(/:\s*""/);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/i18n/catalogue.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 3: Turn on the loose-literal guard**

The configuration is `.eslintrc.json`; `npm run lint` runs
`next lint --dir src --dir tests`. Merge into its `rules`:

```json
{
  "rules": {
    "react/jsx-no-literals": [
      "error",
      {
        "noStrings": true,
        "ignoreProps": true,
        "allowedStrings": ["—", "·", "→", ":", "/", "%", "+", "-", "(", ")"]
      }
    ]
  }
}
```

- [ ] **Step 4: Run lint and fix what it finds**

Run: `npm run lint`
Expected: clean. **Every complaint is a sentence Tasks 6–12 missed.** If a
complaint is genuinely not user-facing text, add it to `allowedStrings` with a
comment saying why — never disable the rule for a file.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/i18n/catalogue.test.ts .eslintrc.json messages/en.json
git commit -m "test(i18n): the two guards that keep the catalogue honest"
```

---

## Task 14: The D7 measurement, the report, the PR

**Files:**
- Create: `scripts/measure-db-messages.mjs`, `docs/block-12a-report.md`

- [ ] **Step 1: Write the measurement**

```js
// scripts/measure-db-messages.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Block 12a, D7. How much of what a user reads is NOT in the catalogue.
 *
 * The error mappers pass `cause.message` straight through for ConflictError,
 * BusinessRuleError and ValidationError -- and that message is whatever a
 * `raise exception` in SQL wrote. The SQLSTATE codes the services map say what
 * KIND of failure it is, never which rule broke, so the English sentence is the
 * only thing that distinguishes them.
 *
 * This counts them and prints them. It decides nothing: Block 12b does, with
 * the list in hand.
 */
const DIRECTORY = join(process.cwd(), 'supabase', 'migrations');

// The codes the services map to error classes whose message reaches the screen.
// 42501 and P0002 are excluded: every mapper replaces those with a sentence of
// its own ("You do not have permission to…", "That could not be found.").
const USER_FACING = ['22023', '23514', '23505'];

const sentences = new Map();

for (const file of readdirSync(DIRECTORY).filter((n) => n.endsWith('.sql'))) {
  const sql = readFileSync(join(DIRECTORY, file), 'utf8');
  const pattern = /raise\s+exception\s+'([^']+)'([^;]*)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const [, message, tail] = match;
    const code = /errcode\s*=\s*'([0-9A-Za-z]+)'/.exec(tail ?? '')?.[1];
    if (!code || !USER_FACING.includes(code)) continue;
    if (!sentences.has(message)) sentences.set(message, { code, files: new Set() });
    sentences.get(message).files.add(file);
  }
}

const rows = [...sentences.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log(`${rows.length} distinct sentence(s) reach a user from SQL:\n`);
for (const [message, { code, files }] of rows) {
  console.log(`  [${code}] ${message}`);
  console.log(`         ${[...files].join(', ')}`);
}
```

- [ ] **Step 2: Run it and keep the output**

Run: `node scripts/measure-db-messages.mjs`
Copy the count and the list into the report. **If the count is zero, the regex
did not match the schema's style — read one `raise exception … using errcode`
site and fix the pattern rather than reporting a zero that is not true.**

- [ ] **Step 3: Run every gate**

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run db:reset
docker restart supabase_kong_CRM_-_LISTENER
npm run db:test
npm run test:isolation
npx playwright test --workers=1
```

Expected: pgTAP **1403** (1397 + 6), isolation **288** (285 + 3), Playwright
**44/44 unedited**, unit 882 plus the new i18n cases.

- [ ] **Step 4: Write `docs/block-12a-report.md`**

Following `docs/block-11c-report.md`: what shipped, what the externalisation
changed in wording (the 18 plurals), **the D7 measurement in full**, the gate
numbers verbatim, and what Block 12b inherits.

- [ ] **Step 5: Commit and open the PR**

```bash
git add scripts/measure-db-messages.mjs docs/block-12a-report.md
git commit -m "docs: the report for Block 12a, and how much of what a user reads comes from SQL"
git push -u origin block-12a
gh pr create --base main --title "Block 12a — the interface speaks, and the content does not" --body-file docs/block-12a-report.md
```

---

## Post-merge

`0135` goes to the hosted project the same day: `npx supabase migration list
--linked`, then `supabase db push`. Nothing in CI applies migrations.
