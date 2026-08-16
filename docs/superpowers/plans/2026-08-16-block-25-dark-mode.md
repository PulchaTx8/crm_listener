# Block 25 — Dark mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A theme a person chooses — System, Light or Dark — from the gear beside
their name, remembered on their profile the way their language is; the dark
palette applied for the first time; and the four semantic colour tokens the
screens need before it can be legible.

**Architecture:** No JavaScript anywhere in the mechanism. `<html>` carries
`light`, `dark`, or no class; no class means System and a
`prefers-color-scheme` media query resolves it at first paint. The middleware
decides the theme and passes it inward on a request header; the root layout only
stamps what it is told. Persistence mirrors `locale` exactly: a nullable column
on `profiles`, a cookie the renderer reads, and a sync in the middleware's
existing profile read.

**Tech Stack:** Next.js 15 (App Router, Server Components, Server Actions),
React 19, TypeScript, Tailwind 3.4, Supabase (Postgres + PostgREST + RLS),
next-intl, Zod 3, Vitest, Playwright, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-16-block-25-dark-mode-design.md` — read
it before Task 1. Decisions are referenced below as D1…D9.

## Global Constraints

- **Migrations are append-only and numbered.** The next free number is `0201`.
  Never edit a migration that has shipped.
- **`grant update (theme) on public.profiles to authenticated` is the line this
  block fails silently without** (D5). The `UPDATE` on `profiles` is per column
  (`0006:33` grants `full_name` and nothing else), and RLS refuses by matching no
  row without raising. `55_profile_theme.test.sql` asserts the grant.
- **No inline `<script>`, no client provider, no `localStorage`.** D2. The CSP
  suite is a gate on this block, not a formality.
- **The dark tokens exist twice and a unit test holds them identical** (D3).
  Never edit one block without the other; the test is what says so.
- **`forwarded()` in the middleware must DELETE `x-theme` before setting it.** It
  copies the client's headers, so a hand-sent `x-theme` would otherwise reach the
  layout on every route the middleware does not overwrite — undoing D7 with
  `curl -H`.
- **Code, comments, commit messages and documentation in English.** UI copy goes
  through `next-intl`; every key exists in `messages/en.json`, `pt.json` and
  `es.json` or `tests/unit/i18n/catalogue.test.ts` fails.
- **Gate order:** `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run db:reset`, `npm run db:test`, `npm run seed:branding`,
  `npm run test:e2e`, `npm run test:isolation`. `db:test` after the reset and
  never after an e2e run — a dirty local database gives two false reds.
- **Run every suite in the foreground** with an explicit long timeout.
- **The isolation harness reds out on a pre-existing worker crash** (two workers
  die after their files pass). Characterise, do not chase: a direct
  `npx vitest run --config vitest.isolation.config.ts` reports every file.
- **Branch:** `block-25-dark-mode`, already created off `main`.
- **Commit after every task.**

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0201_profile_theme.sql` | The column, its check, and the column-scoped grant |
| `src/lib/theme/theme.ts` | The vocabulary, the resolution order, the cookie sync rule |
| `src/app/(app)/theme-actions.ts` | `setThemeAction` |
| `src/components/layout/settings-menu.tsx` | The gear menu: languages, a divider, three themes |
| `supabase/tests/55_profile_theme.test.sql` | The check and THE GRANT |
| `tests/unit/theme.test.ts` | Resolution order, cookie sync, hostile input |
| `tests/unit/theme-tokens.test.ts` | The two dark blocks are identical; every `:root` token has a dark counterpart |
| `tests/isolation/theme.test.ts` | A member writes their own theme and not a colleague's |
| `tests/e2e/dark-mode.spec.ts` | The journey, the second browser, and the widget's two exposures |

**Deleted**

| Path | Why |
|---|---|
| `src/components/layout/locale-selector.tsx` | Becomes `settings-menu.tsx` — a file called "locale" that owns the theme is a name that has stopped being true |

**Modified**

| Path | Change |
|---|---|
| `src/app/globals.css` | `--success`/`--warning` in both palettes; the dark block repeated under the media query; `color-scheme` |
| `tailwind.config.ts` | `success`/`warning` colours; `darkMode` becomes a two-trigger variant |
| `src/middleware.ts` | `theme` in the profile select; the cookie sync; `x-theme` deleted then set |
| `src/app/layout.tsx` | Stamps the class from `x-theme` |
| `src/components/layout/app-shell.tsx` | Renders `SettingsMenu` |
| `src/lib/supabase/database.types.ts` | Regenerated |
| 26 component files | 58 literal colour classes become the four tokens |
| `messages/{en,pt,es}.json` | Theme labels |
| `tests/e2e/language.spec.ts` | Moves with the renamed menu |

---

## Tasks

### Task 1 — `0201`: the column and the grant (D5, D6)

- [ ] `0201_profile_theme.sql`: `theme text check (theme in ('light','dark'))`,
      nullable, with the column comment saying NULL is System; and
      `grant update (theme) on public.profiles to authenticated`.
- [ ] `supabase/tests/55_profile_theme.test.sql`: the column exists; the check
      refuses `'system'` and any other string; **`has_column_privilege
      ('authenticated', 'public.profiles', 'theme', 'UPDATE')` is true** and the
      same is NOT true of `must_change_password`, so the assertion proves the
      grant is column-scoped rather than a blanket one.
- [ ] `npm run db:reset` then `npm run db:test`.
- [ ] Regenerate `database.types.ts`.
- [ ] Commit.

### Task 2 — `src/lib/theme/theme.ts` (D1, D6)

- [ ] Write `tests/unit/theme.test.ts` FIRST: the resolution order (profile beats
      cookie beats null); `resolveTheme` returning null for System; junk in either
      input discarded rather than passed on; `themeCookieUpdate` returning
      `'clear'` for a profile that chose System over a browser holding `dark` —
      the case `localeCookieUpdate` has no equivalent of, because a locale cannot
      be un-chosen.
- [ ] `theme.ts`: `Theme`, `ThemeChoice`, `THEME_CHOICES` (System first — it is
      the default state, and the menu renders in this order), `isTheme`,
      `isThemeChoice`, `resolveTheme`, `themeCookieUpdate`. Free of Next imports,
      like `src/i18n/locales.ts`.
- [ ] Commit.

### Task 3 — The tokens (D3, D9)

- [ ] Write `tests/unit/theme-tokens.test.ts` FIRST: parse `globals.css`; the
      `:root.dark` block and the media-query block declare the same token names
      with the same values; every custom property in `:root` has a counterpart in
      the dark block (this is what catches a fifth token added to one only).
- [ ] `globals.css`: `--success`/`--success-foreground` and
      `--warning`/`--warning-foreground` in `:root` and in the dark block, each
      with its measured contrast against the page and against the `/10` surface
      written beside it, the way every token in that file already is.
- [ ] Repeat the dark block under
      `@media (prefers-color-scheme: dark) { :root:not(.light) { … } }`, with a
      comment saying the test is what keeps the two identical.
- [ ] `color-scheme: light` on `:root`, `dark` on both dark blocks — form
      controls and scrollbars follow nothing else.
- [ ] `tailwind.config.ts`: `success` and `warning` in the colour map, in the
      `hsl(var(--x))` form that keeps `/10` opacity working; `darkMode` becomes
      `['variant', ['&:is(.dark *)', '@media (prefers-color-scheme: dark) { &:not(.light *) }']]`.
- [ ] `brand-tokens.test.ts` must still pass — it parses this file.
- [ ] Commit.

### Task 4 — The middleware and the layout (D4, D7)

- [ ] `forwarded()` deletes `x-theme` unconditionally, with the comment saying
      why: it copies the client's headers, and D7 would otherwise fall to
      `curl -H 'x-theme: dark'`.
- [ ] `theme` joins the existing profile select beside `locale`.
- [ ] `themeCookieUpdate` runs in the same block as `localeCookieUpdate`, writing
      onto both the request and the response — and CLEARING the cookie when the
      profile says System, which the locale sync has no case for.
- [ ] The resolved theme is set on the forwarded request headers. The widget
      branch returns before this and must stay that way.
- [ ] `src/app/layout.tsx` reads `x-theme` and stamps `className`; absent or
      unrecognised stamps nothing.
- [ ] Commit.

### Task 5 — The menu (the owner's own instruction)

- [ ] `locale-selector.tsx` → `settings-menu.tsx`: same gear, same `<details>`,
      same one-form-per-option. A divider, then System / Light / Dark, each
      posting to `setThemeAction`.
- [ ] `src/app/(app)/theme-actions.ts`: `setThemeAction`, mirroring
      `setLocaleAction` — cookie first and even when the profile write fails, row
      read back, `revalidatePath('/', 'layout')`. System deletes the cookie and
      writes NULL.
- [ ] `app-shell.tsx` renders it.
- [ ] Locale keys in all three files.
- [ ] `tests/e2e/language.spec.ts` moves with the rename.
- [ ] Commit.

### Task 6 — The 58 colours (D9)

- [ ] Sweep 26 files: `text-emerald-*` → `text-success`;
      `bg-emerald-100 text-emerald-900` → `bg-success/10 text-success`;
      the amber and orange families → the `warning` equivalents. The pattern is
      `SITUATION_CLASSES`'s existing `bg-destructive/10 text-destructive`.
- [ ] Delete the three hand-written `dark:` variants the sweep makes redundant.
- [ ] Includes `participation-dialog.tsx`, whose `text-emerald-700` this author
      added in Block 24.
- [ ] `grep` for the palette classes must come back empty afterwards, and that
      grep is the check — not a reading of the diff.
- [ ] Commit.

### Task 7 — The proof, and the gates

- [ ] `tests/isolation/theme.test.ts`: a member writes their own theme through
      the service path and cannot write a colleague's.
- [ ] `tests/e2e/dark-mode.spec.ts`: choose Dark → `<html class="dark">` →
      reload → still dark; the same person in a FRESH context finds it (the
      profile half, which `localStorage` could not do); System removes the class;
      and `/w/<key>` carries no class with **a dark cookie AND a hand-sent
      `x-theme: dark`** both present.
- [ ] Every gate in order, foreground, long timeout.
- [ ] Commit, push, open the PR — saying in its body that `0201` is additive and
      safe in both orders, unlike Block 24's.

---

## Risks

- **The grant forgotten, or added blanket.** D5. The pgTAP asserts both halves.
- **`x-theme` trusted from the client.** Closed in Task 4 and asserted in Task 7.
- **The two dark blocks drifting.** Closed by Task 3's test, which must be
  written before the second block exists.
- **A `dark:` utility that no longer resolves.** The `darkMode` variant changes
  shape in Task 3; the three existing utilities are deleted in Task 6, so the
  window where both matter is one task wide.
- **The renamed menu breaking `language.spec.ts` silently.** It selects by
  testid; the rename keeps the ids or moves them deliberately, never both.
