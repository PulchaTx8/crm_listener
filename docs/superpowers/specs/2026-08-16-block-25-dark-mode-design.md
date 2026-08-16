# Block 25 — The dark palette that was already written gets a switch

**Status:** design agreed with the owner, 2026-08-16.
**Scope:** a theme a person chooses — System, Light or Dark — from the gear
beside their name, remembered on their profile the way their language is; the
dark palette applied for the first time; and the four semantic colour tokens the
screens need before it can be legible.
**Depends on:** Block 8a (the chart palette, already authored for both themes),
Block 11b (the CSP this design is shaped to stay clear of), Block 12a (`0135`,
`profiles.locale`, `resolveLocale` and the middleware's cookie sync — the whole
mechanism this one mirrors), Block 12b (`locale-selector.tsx`, the menu this one
grows into).

---

## 1. What this is for

**The dark palette already exists and nothing can reach it.**
`tailwind.config.ts` has carried `darkMode: ['class']` since the shadcn setup,
and `globals.css` carries a complete `.dark` block: every token, a dark chart
palette with its CVD separation validated, a sidebar deliberately left alone
because it was already dark, and a primary that is a lighter tint of the brand
purple *because somebody measured #4811EF at 2.3:1 on the dark page and refused
it*. That work is done, and it has never been shown to anybody, because nothing
in the product adds the class.

So this block is not "build dark mode". It is: put a switch on what is built,
persist the choice, and fix the fifty-eight colours that were written as literals
and will not follow.

---

## 2. What already exists and is reused

Stated first because it is most of the block, and because the risk here is
rebuilding what is already built.

- **The `.dark` token block** (`globals.css`) — kept verbatim, values and
  comments. Its measured contrast ratios are the reason it exists.
- **`src/i18n/locales.ts`** is the shape `src/lib/theme/` copies: a module free
  of Next imports, holding the vocabulary, the type guard and the resolution
  order, so the order can be asserted directly and everything above it is
  plumbing.
- **`setLocaleAction`** (`app/(app)/locale-actions.ts`) is the shape
  `setThemeAction` copies, down to the two things that look like paranoia and are
  not: the cookie is written FIRST and even when the profile write fails, and the
  row is READ BACK because RLS refuses by matching no row and raises nothing.
- **`LocaleSelector`** is the menu this grows into, and its whole architecture is
  reused: a Server Component using `<details>` with one form per option, so it
  works before hydration, adds nothing to the bundle of a shell every screen
  renders, and has no inline handler for the CSP to bless.
- **The middleware's profile read** already selects
  `must_change_password, provisional_expires_at, locale` for a signed-in caller,
  and already syncs the locale cookie onto both the request and the response.
  `theme` joins that select and costs no query.
- **The middleware's widget branch** already returns early with its own CSP
  before that profile read is reached.
- **`0135_profile_locale.sql`** is the migration `0201` copies, including the one
  line that matters most — see D5.

---

## 3. Decisions

**D1 — Three states, and the third is the absence of the other two.** System,
Light, Dark. `<html>` carries `class="light"`, `class="dark"`, or **no class at
all**; no class means System, and a `@media (prefers-color-scheme: dark)` query
resolves it in the browser at first paint.

This is what makes the two audience decisions below free rather than a second
mechanism: "follow the system" is not something to build, it is what happens when
nothing is stamped.

**No JavaScript is involved at any point, and there is no flash in any state.**
When the person has chosen, the server already knows before the first byte; when
they have not, the media query resolves before the first paint. That is the
argument that rejected `next-themes` — see D2.

**D2 — `next-themes` is rejected, and not on taste.** It resolves the flash with
an inline `<script>`, which this product's CSP would have to bless with a nonce —
the fight Block 11b documents at length. It persists to `localStorage`, which
contradicts the owner's instruction that the choice be remembered per USER: a
person signing in from another browser would not find their theme. And it puts a
client provider inside a shell that every single screen renders.

A `data-theme` attribute instead of a class was also considered and rejected: it
is equivalent in every way except that it would mean rewriting a `.dark` block
that already exists, already measured.

**D3 — The dark block appears twice, and a test is what makes that safe.**
The tokens must apply under `:root.dark` (chosen) and under
`@media (prefers-color-scheme: dark) { :root:not(.light) }` (system). CSS cannot
put a media query inside a selector list, so there is no way to write the block
once.

The alternative was declaring the values once as `--d-*` on `:root` and
re-pointing from two thin blocks. It was rejected: it trades one duplication for
an indirection that doubles the custom properties on `:root` and makes the file
harder to read for the next person, while STILL duplicating the mapping.

So the block is duplicated, and `tests/unit/theme-tokens.test.ts` parses
`globals.css` and asserts the two blocks name exactly the same tokens with
exactly the same values. Drift becomes impossible rather than unlikely. This is
not a new idea here: `tests/unit/brand-tokens.test.ts` already parses this file
and converts its HSL to assert a hex.

**D4 — The middleware decides the theme; the layout only stamps it.** The
middleware computes the resolved theme for a signed-in caller and passes it on a
request header. `src/app/layout.tsx` reads that header and stamps the class —
and stamps nothing when the header is absent.

One decision in one place, rather than splitting "what is the theme" and "may
this route have one" across two files. It also means the widget and the public
pages need no code: they are the routes the middleware never sets the header for.

**D5 — The `UPDATE` grant on `profiles` is per COLUMN, and that is the line this
block fails silently without.** `0006` grants `update (full_name)` and nothing
else; `0135` had to add `grant update (locale)`. A new column is writable by
nobody until it is named, and the failure has two shapes: a missing column grant
raises `42501`, which is the kind one, while RLS refuses by MATCHING NO ROW and
raises nothing at all.

So `0201` carries `grant update (theme) on public.profiles to authenticated`,
`setThemeAction` reads the row back rather than trusting the absence of an error,
and `55_profile_theme.test.sql` asserts the grant exists — because that assertion
is the one that would catch a whole feature failing quietly.

**D6 — NULL is System, and it is also "never chose".** `profiles.theme` is
`text check (theme in ('light','dark'))`, nullable. Choosing System actively
writes NULL and deletes the cookie.

The two facts are deliberately not told apart, and that is the same ruling `0135`
made for `locale`: they resolve identically, and a third stored value would be a
distinction nothing downstream could act on.

**D7 — The widget follows the site that hosts it, structurally rather than
incidentally.** The owner's ruling. Worth recording that it would *appear* to
hold even without this block doing anything: a cookie belongs to a browser, and a
listener's browser has never had ours — the only person who could see an operator
theme on a widget is that operator, previewing their own.

That is exactly the kind of guarantee this codebase refuses to rest on. "Listeners
happen not to have our cookie" is one deploy away from being wrong. The middleware
never sets the theme header on `/w`, so the widget cannot inherit a theme
whatever the cookies say, and `tests/e2e/dark-mode.spec.ts` asserts it with a dark
cookie deliberately present.

**D8 — Public pages follow the system.** Login, the legal pages, the contact form
and the deletion request have no profile to remember anything in. They get no
header, therefore no class, therefore the system's preference. Somebody who runs
their machine dark does not get a white flash on the login screen.

Deliberately NOT the cookie, though it would be free: a cookie is the browser's
memory, not the person's, and on a shared studio machine it would show one
person's choice to the next.

**D9 — Four semantic tokens, not fifty-eight `dark:` variants.** `--success` /
`--success-foreground` and `--warning` / `--warning-foreground`, in both palettes,
with contrast measured against the page and against the `/10` surface.

The usage pattern already exists in this codebase and is copied rather than
invented: `SITUATION_CLASSES` (`promotions/format.ts`) writes a cancelled
promotion as `bg-destructive/10 text-destructive`. So `text-emerald-700` becomes
`text-success`, and `bg-emerald-100 text-emerald-900` becomes
`bg-success/10 text-success` — the same shape the red already has.

The `dark:` variant per site was rejected for what it leaves behind: the palette
stays scattered across twenty-six files, and the next colour anybody adds is born
with the same problem. Three files already carry hand-written `dark:` variants,
which is what that future looks like.

**This forecloses one thing, and it is worth saying out loud:** tokens are
theme-aware but not shade-aware, so a screen wanting "a lighter success" has one
colour and the `/N` opacity modifier, not a fifty-to-nine-hundred ramp. That is
the trade every token in this file already makes.

---

## 4. The database

One migration, `0201`.

```sql
alter table public.profiles
  add column theme text
  constraint profiles_theme_supported check (theme in ('light', 'dark'));

grant update (theme) on public.profiles to authenticated;
```

NULL is System (D6). The grant is D5 and is the whole migration's reason to be
read carefully.

No RLS change: `profiles` already carries the policy that lets a person write
their own row, which is what `locale` rides on.

---

## 5. The code

### 5.1 `src/lib/theme/theme.ts` — the vocabulary and the order

Free of Next imports, like `src/i18n/locales.ts`, so the resolution can be
asserted directly.

- `type Theme = 'light' | 'dark'` and `type ThemeChoice = Theme | 'system'`.
- `THEME_CHOICES = ['system', 'light', 'dark']` — the order the menu renders,
  System first because it is the default state.
- `isTheme(value)` / `isThemeChoice(value)` — every input is untrusted: the
  cookie is client-writable and a form post is not obliged to agree with the
  menu.
- `resolveTheme({ profile, cookie })` → `Theme | null`. **Null means System**,
  which is the value that stamps no class. Profile, then cookie, then null.
- `themeCookieUpdate({ profile, cookie })` → the sibling of `localeCookieUpdate`,
  and it needs one more state than that function has: a profile of NULL must be
  able to CLEAR a stale cookie, because "I chose System" has to travel between
  browsers exactly as "I chose Dark" does. So it returns `Theme | 'clear' | null`.

### 5.2 `globals.css` — the same tokens, reachable

`:root` keeps the light palette and gains `--success` / `--warning`. The `.dark`
block keeps every value and comment it has and gains the two dark counterparts.
A second block repeats the dark tokens under
`@media (prefers-color-scheme: dark) { :root:not(.light) }` (D3).

`color-scheme` is declared alongside — `light` on `:root`, `dark` on the two dark
blocks — so form controls, scrollbars and the browser's own UI follow, which no
amount of token work would do on its own.

### 5.3 `tailwind.config.ts`

`success` and `warning` join the colour map, in the `hsl(var(--x))` form every
token there already uses — which is what keeps `/10` opacity modifiers working.

`darkMode` becomes
`['variant', ['&:is(.dark *)', '@media (prefers-color-scheme: dark) { &:not(.light *) }']]`
so the handful of hand-written `dark:` utilities follow both triggers rather than
only the explicit class. Most of them disappear in §5.6 regardless; the ones in
`widget-tab.tsx` and `register-member-form.tsx` are amber notices that §5.6
converts, so this may end the block with no consumers at all — kept because the
variant must be correct for whoever writes the next one.

### 5.4 `src/middleware.ts`

`theme` joins the existing profile select. `themeCookieUpdate` runs beside
`localeCookieUpdate`, in the same block, for the same reason its comment already
gives: that row was loaded anyway.

The resolved theme goes onto the forwarded request headers as `x-theme`. Absent
means System. The widget branch returns before any of this and therefore never
sets it (D7).

**THE HEADER IS DELETED BEFORE IT IS SET, ON EVERY REQUEST, AND THAT LINE IS NOT
DEFENSIVE PADDING.** `forwarded()` builds its headers from
`new Headers(request.headers)` — the CLIENT's headers, copied. So a request
arriving with an `x-theme: dark` header of its own would carry it straight
through to the layout on every route the middleware does not overwrite it for:
the widget, and every public page. D7's whole structural guarantee would be
undone by a header anybody can send, and `curl -H 'x-theme: dark'` is the entire
exploit.

It is a cosmetic hole rather than a dangerous one — the worst outcome is somebody
rendering their own widget dark — but it is the exact shape of the mistake this
design was chosen to avoid, so `forwarded()` deletes `x-theme` unconditionally
and the panel branch sets it afterwards. The e2e sends the header deliberately
and asserts the widget still carries no class.

This is a general property of the helper rather than a fact about this block: any
future header the middleware forwards inward as a trusted value has the same
hole, and `x-theme` is simply the first one. The nonce and the CSP above it are
already `set` (which overwrites) rather than merged, so neither is affected.

### 5.5 `src/app/layout.tsx`

Reads `x-theme` and stamps `className` on `<html>`. Absent or unrecognised stamps
nothing. Three lines, and the only place in the product that writes the class.

### 5.6 The menu, and the fifty-eight colours

`locale-selector.tsx` becomes `settings-menu.tsx`: the same gear, the same
`<details>`, the same one-form-per-option, plus a divider and three theme rows.
Renamed rather than extended in place, because a file called "locale" that also
owns the theme is a name that has stopped being true — the rule this codebase
applied when Inventory's nav item became Stock. `language.spec.ts` moves with it.

Then the sweep: fifty-eight literal colour classes across twenty-six files become
the four tokens. Two families — emerald for "this counted / right answer", amber
for "read this before you continue" — plus one orange that is a warning wearing a
different hue.

Included in the sweep is the `text-emerald-700` this author added to
`participation-dialog.tsx` in Block 24.

---

## 6. What is deliberately not done

- **No theme per Station and none in the widget's own settings.** D7 settles the
  widget by having it follow the host, which needs no setting.
- **No `Sec-CH-Prefers-Color-Scheme`.** It would let the server resolve System
  too, removing nothing — there is no flash to remove — in exchange for a
  Chromium-only client hint and an `Accept-CH` negotiation.
- **No high-contrast or per-token customisation.** One dark palette, the one that
  is already written and measured.
- **`prefers-reduced-motion` is untouched**, though it is the obvious neighbour.

---

## 7. How this is proved

- **Unit** — the two dark blocks hold the same tokens with the same values
  (parsing `globals.css`); every token named in `:root` has a counterpart in
  `.dark`, which is what catches a fifth token added to one and not the other;
  the resolution order; `themeCookieUpdate` clearing a stale cookie for a profile
  that chose System; `isThemeChoice` refusing junk.
- **pgTAP** — the check constraint, and **the column-scoped UPDATE grant**, which
  is the assertion that catches the whole feature failing quietly (D5).
- **`tests/isolation`** — a member writes their own theme through the real action
  path and cannot write a colleague's.
- **e2e** — choosing Dark stamps the class and survives a reload; the same person
  in a FRESH browser context finds their theme, which is the profile half and the
  thing `localStorage` could not do; choosing System removes the class; and
  **`/w/<key>` carries no class with a dark cookie AND a hand-sent `x-theme:
  dark` header deliberately present** — the two ways D7 could be undone, asserted
  together.
- **The suites that must not regress** — `language.spec.ts` (the menu it drives
  is renamed under it), `brand-tokens.test.ts` (it parses the file §5.2
  restructures), and `csp.spec.ts` (this block adds no inline script, and that is
  a claim worth re-running rather than asserting).
