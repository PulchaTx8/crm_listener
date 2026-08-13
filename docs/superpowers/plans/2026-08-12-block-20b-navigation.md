# Block 20b — Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder and rename the sidebar to describe the product, move Pedidos to
Audiência, replace the Catálogo item with Gravadoras/Gêneros/Álbuns, turn every
section into a collapsible disclosure remembered in a cookie, and land sign-in on
the audience dashboard.

**Architecture:** Three of the four changes are the contents and order of one
array in `src/lib/auth/shell.ts`. The fourth is a disclosure in
`src/components/layout/sidebar-nav.tsx`, whose decision — which sections are open
— is extracted into a pure, unit-testable module so it is not reachable only
through a browser. A cookie read on the server carries the caller's expansions so
the sidebar arrives correct rather than correcting itself after hydration.

**Tech Stack:** Next.js 15 App Router (Server Components), React 19, next-intl,
Playwright, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-block-20b-navigation-design.md`.
  Every decision traces to a D-number in its §2.
- **Branch:** `block-19-whatsapp-entry`, already checked out. Do not create a
  branch, do not merge. Block 20a's commits are on it and PR #65 is open; these
  commits join the same branch.
- **Language:** code, comments, commit messages in English. User-facing copy in
  `messages/pt.json`, `en.json` and `es.json`, all three, always.
- **Message keys are single-quoted literals at the call site, never composed.**
  `tests/unit/i18n/usage.test.ts` reads the AST for literal keys only, and
  next-intl renders the key itself when a message is absent.
- **The house icon rule:** two ADJACENT rows of the SAME section must never share
  a glyph. Reuse across distant sections is fine and already happens (`box`
  serves both Estoque and Retiradas). Every new glyph in `ICONS` carries a
  comment saying why nothing already declared meant it.
- **Gate order:** `npm run typecheck`, `lint`, `test`, then `db:reset`,
  `db:test`, `seed:branding`, `test:e2e`, `test:isolation`. `db:test` before the
  e2e and isolation suites, never after. `seed:branding` after `db:reset` because
  the reset empties Storage and `login.spec.ts` asserts the branding image.
- **The isolation suite crashes about two runs in five** from a known,
  undiagnosed flake (six crashes in fifteen runs, six different files, no
  repeats). If `verify-isolation-suite.mjs` reports an incomplete run, re-run it
  **once** from a clean database. If the same file drops out twice, stop and
  report — a repeat would be the first evidence of a real cause. Never weaken the
  guard.
- Commit after every task. Do not push until the final task.

---

## File Structure

**Created:**

- `src/lib/nav/disclosure.ts` — the pure decision: which sections are open, given
  a cookie value and a path. Exists to be importable by a test; the panel-level
  branch would otherwise be checked by nothing. Task 2.
- `tests/unit/nav-disclosure.test.ts` — its tests. Task 2.
- `tests/e2e/nav.ts` — the `openNavSection` helper the thirteen sidebar-driven
  specs call. Task 3.

**Modified:**

- `src/lib/auth/shell.ts` — the section array: order, labels, the Pedidos move,
  the three catalogue items, and a `key` per section. Tasks 1 and 4.
- `src/components/layout/sidebar-nav.tsx` — `NavSection` gains `key`; the section
  heading becomes a disclosure button. Tasks 1 and 3.
- `src/components/layout/app-shell.tsx` — two new `ICONS` paths. Task 1.
- `messages/pt.json`, `en.json`, `es.json` — three new `nav` keys, one retired.
  Task 1.
- `src/middleware.ts`, `src/app/(auth)/login/page.tsx`,
  `src/app/(auth)/change-password/page.tsx` — the member home becomes one
  constant pointing at the audience dashboard. Task 4.
- Thirteen e2e specs — one helper call each. Task 3.
- `tests/e2e/dashboards.spec.ts` — the comment claiming the section heading is a
  `<p>`. Task 3.

---

## Task 1: The sidebar lists the right things, in the right order

**Files:**
- Modify: `src/lib/auth/shell.ts`
- Modify: `src/components/layout/sidebar-nav.tsx` (the `NavSection` interface and
  the section wrapper's `data-nav-section`)
- Modify: `src/components/layout/app-shell.tsx` (`ICONS`)
- Modify: `messages/pt.json`, `messages/en.json`, `messages/es.json`
- Test: `tests/e2e/nav-content.spec.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `NavSection` gains `key: string`. The eleven keys, exactly: `'overview'`,
    `'dashboards'`, `'inventory'`, `'audience'`, `'promotions'`, `'catalog'`,
    `'templates'`, `'organization'`, `'reports'`, `'administration'`,
    `'platform'`.
  - Each section renders a wrapper carrying `data-nav-section={section.key}`.
    Tasks 2 and 3 both depend on this attribute.

**Nothing collapses in this task.** The tree arrives in Task 3. Everything here
is content and order, and the whole e2e suite must stay green without a single
helper call.

- [ ] **Step 1: Write the failing e2e**

Create `tests/e2e/nav-content.spec.ts`. Model the sign-in on an existing spec —
`tests/e2e/dashboards.spec.ts` shows the pattern this suite uses to provision an
owner and sign in; reuse `tests/e2e/provision.ts` rather than inventing a second
way in.

The assertions, after signing in:

```ts
// Block 20b, D1/D2/D3. The sidebar's CONTENTS and ORDER, asserted by section
// rather than by counting links: a link exists somewhere is not the claim --
// the claim is that Requests is filed under Audience and no longer under the
// catalogue, which is the whole of item 3.
//
// English, because playwright.config.ts pins locale: 'en-US' for the suite.
const audience = page.locator('[data-nav-section="audience"]');
await expect(audience.getByRole('link', { name: 'Requests' })).toBeVisible();

const catalogue = page.locator('[data-nav-section="catalog"]');
await expect(catalogue.getByRole('link', { name: 'Requests' })).toHaveCount(0);
await expect(catalogue.getByRole('link', { name: 'Record labels' })).toBeVisible();
await expect(catalogue.getByRole('link', { name: 'Genres' })).toBeVisible();
await expect(catalogue.getByRole('link', { name: 'Albums' })).toBeVisible();
// The item this replaces is gone: a section named Catalogue holding an item
// named Catalogue is the "one link rendered twice" shell.ts warns about in
// three separate comments.
// 'Catalog', not 'Catalogue': messages/en.json spells it without the -ue, and
// asserting the absence of a string the product never used would pass whether
// or not the leftover item is actually gone.
await expect(catalogue.getByRole('link', { name: 'Catalog', exact: true })).toHaveCount(0);

// D3. The two administrative sections sit AFTER Organization, at the foot of
// the list -- which is the opposite of what the owner's item 8 literally said
// and what they actually meant (spec §2 D3).
const keys = await page.locator('[data-nav-section]').evaluateAll((nodes) =>
  nodes.map((n) => n.getAttribute('data-nav-section')),
);
expect(keys).toEqual([
  'overview', 'dashboards', 'inventory', 'audience', 'promotions',
  'catalog', 'templates', 'organization', 'reports', 'administration',
  'platform',
]);
```

The last assertion expects `'platform'` — so this spec must sign in as a
**platform admin**. If provisioning one is awkward, sign in as an ordinary owner
and drop `'platform'` from the expected array, adding a comment saying the
section is admin-only and is asserted by its absence. Do not assert an order you
did not actually render.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/nav-content.spec.ts
```

Expected: FAIL. `[data-nav-section]` matches nothing — the attribute does not
exist yet — so the first `expect` times out.

- [ ] **Step 3: Give NavSection a key and render it**

In `src/components/layout/sidebar-nav.tsx`, extend the interface:

```tsx
export interface NavSection {
  /**
   * A stable identifier, and NOT the label.
   *
   * Block 20b, D5. `label` is the output of `t('audience')` — translated, and
   * different in every language. The disclosure cookie (Task 3) is keyed on
   * this, so keying it on the label would forget every expansion the moment
   * somebody switched language, and would key a Portuguese and an English
   * installation differently for no reason. The two happen to spell the same
   * word today; neither is derived from the other, and renaming a section's
   * copy must never silently reset everybody's sidebar.
   */
  key: string;
  label: string;
  items: NavItem[];
}
```

and change the section wrapper's `key` prop to use it, adding the attribute:

```tsx
        <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
```

- [ ] **Step 4: Add the two new icons**

In `src/components/layout/app-shell.tsx`, inside `ICONS`, after `chart`:

```ts
  // A tag, for Block 20b's Genres. Its own path rather than reusing anything
  // here: `music` is Songs on an adjacent row of the SAME section, which is
  // exactly the case the house rule forbids, and nothing else declared means
  // *a label you file something under* — which is what a genre is.
  tag: 'M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  // A disc, for Block 20b's Albums. Its own path for the same reason as `tag`
  // directly above -- it sits two rows from Songs -- and because an album is a
  // physical object in a way a note is not: `box` was the near miss and reads
  // as a package, which is Inventory's meaning of it.
  disc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
```

- [ ] **Step 5: Add the copy to all three catalogues**

Under `nav`, keeping each file's existing alphabetical placement:

`messages/pt.json`: `"albums": "Álbuns"`, `"genres": "Gêneros"`, `"labels": "Gravadoras"`
`messages/en.json`: `"albums": "Albums"`, `"genres": "Genres"`, `"labels": "Record labels"`
`messages/es.json`: `"albums": "Álbumes"`, `"genres": "Géneros"`, `"labels": "Discográficas"`

Delete `nav.music` from all three. It labelled the section being renamed and has
no remaining caller. `nav.catalog` stays and changes job: it labelled the ITEM
being removed and becomes the SECTION's label, which is the one place its
wording was always right.

`tests/unit/i18n/catalogue.test.ts` compares the three catalogues to each other,
so all three change together or none do.

- [ ] **Step 6: Rewrite the section array**

In `src/lib/auth/shell.ts`, add `key` to every section literal and put them in
this order: `overview`, `dashboards`, `inventory`, `audience`, `promotions`,
`catalog`, `templates`, `organization`, `reports`, `administration`. The
`if (isAdmin)` push at the bottom gains `key: 'platform'` and stays last.

**Move the existing comment blocks with their sections.** Each one explains why
that section is visible to every member and where the real boundary is; a
comment left behind now describes the wrong section.

Three content changes inside the array:

1. **Audience gains Pedidos, last:**

```tsx
        // Block 20b, D1, on the owner's ruling. This is the listing of PEOPLE
        // asking for something, and it belongs beside the audience rather than
        // beside the recordings it happens to reference — the same argument
        // Block 6c used to move Participations here out of Promotions. The
        // href does not change.
        //
        // ICONS.music rather than ICONS.ticket, which is what it carried under
        // the catalogue: `ticket` is Participations, two rows up in THIS SAME
        // section, and one glyph on two adjacent rows reads as one link
        // rendered twice. `music` is unused in Audience and a song request is
        // the one thing here that is about a recording; its other uses are in
        // Dashboards and Catalogue, distant sections.
        { href: '/music/requests', label: t('requests'), icon: ICONS.music },
```

2. **Music becomes Catalogue, and its `catalog` item becomes three:**

```tsx
      label: t('catalog'),
      items: [
        { href: '/music/songs', label: t('songs'), icon: ICONS.music },
        { href: '/music/artists', label: t('artists'), icon: ICONS.users },
        // Block 20b, D2. These three replace the single "Catalogue" item, which
        // could not survive the section's rename: a section and an item
        // spelling the same word read as one link rendered twice, the rule this
        // file already records for Inventory > Stock and for the three
        // Dashboards entries.
        //
        // The addresses already answer — `parseCatalogTab`
        // (music/catalog/page.tsx) reads exactly this three-word vocabulary —
        // so this block ships the NAVIGATION and Block 20c replaces what those
        // addresses render. ICONS.building for a label because a label is a
        // company and `building`'s only other use is Platform > Organizations,
        // a distant section; `tag` and `disc` are new (app-shell.tsx says why).
        { href: '/music/catalog?tab=labels', label: t('labels'), icon: ICONS.building },
        { href: '/music/catalog?tab=genres', label: t('genres'), icon: ICONS.tag },
        { href: '/music/catalog?tab=albums', label: t('albums'), icon: ICONS.disc },
        { href: '/music/maintenance', label: t('maintenance'), icon: ICONS.shield },
      ],
```

Delete the `/music/requests` entry from this section. Keep Maintenance last and
keep its comment.

3. **Reports and Administration move to the end**, after Organization, with
   their comment blocks. Add one line to the Reports comment recording why:

```tsx
      // Block 20b, D3. Moved here from third in the list. The owner's item 8
      // read "before Modelos", which was already true — these sat third and
      // fourth and Templates was ninth — and the intent was the opposite
      // direction: two administrative sections were cutting the operational
      // ones (Stock, Audience, Promotions, Catalogue) in half, and they gather
      // at the foot of the list instead.
```

`NavItem.href` is typed `Route`. `'/music/catalog?tab=labels'` is a static route
with a query string and typedRoutes accepts it; if `npm run typecheck`
disagrees, report it rather than reaching for `as Route` — a cast here would
hide a real typing question about query strings in this codebase.

- [ ] **Step 7: Run the gates that can see this**

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
```

Expected: PASS. `usage.test.ts` catches a key referenced in code and missing
from a catalogue; `catalogue.test.ts` catches a key added to two files of three.

- [ ] **Step 8: Run the new e2e and the ones that touch the moved links**

```bash
npx playwright test tests/e2e/nav-content.spec.ts tests/e2e/music-requests.spec.ts tests/e2e/music-catalogue.spec.ts
```

Expected: PASS. `music-requests.spec.ts` reaches Requests through the sidebar and
is the one most likely to notice the move.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/shell.ts src/components/layout/sidebar-nav.tsx src/components/layout/app-shell.tsx messages/pt.json messages/en.json messages/es.json tests/e2e/nav-content.spec.ts
git commit -F- <<'EOF'
feat(20b): the sidebar lists what the product does, in an order somebody chose

Twenty blocks of appending left eleven sections in build order. Requests moves
to Audience, because it is people asking rather than a record in the catalogue.
Music becomes Catalogue, and its "Catalogue" item becomes Record labels, Genres
and Albums -- the item could not survive the rename, since a section and an item
spelling one word read as one link rendered twice.

Reports and Administration move to the END. Item 8 said "before Modelos", which
was already true; the owner meant the opposite direction, and two administrative
sections were cutting the operational ones in half.

Every section gains a key that is NOT its label: the label is translated, and
Task 3's cookie keyed on it would forget every expansion the moment somebody
switched language.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: Which sections are open, as a function

**Files:**
- Create: `src/lib/nav/disclosure.ts`
- Test: `tests/unit/nav-disclosure.test.ts`

**Interfaces:**
- Consumes: the section keys Task 1 produced.
- Produces, all imported by Task 3:
  - `NAV_COOKIE: 'pulchatx_nav_open'`
  - `NAV_COOKIE_MAX_AGE: number`
  - `parseExpanded(raw: string | undefined | null): string[]`
  - `serializeExpanded(keys: readonly string[]): string`
  - `activeSectionKey(sections: readonly { key: string; items: readonly { href: string }[] }[], pathname: string): string | null`
  - `isSectionOpen(key: string, activeKey: string | null, expanded: readonly string[]): boolean`

**No UI changes in this task.** It adds a module and its tests; the sidebar still
renders everything open. The branch stays green.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/nav-disclosure.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  activeSectionKey,
  isSectionOpen,
  parseExpanded,
  serializeExpanded,
} from '@/lib/nav/disclosure';

const SECTIONS = [
  { key: 'overview', items: [{ href: '/app' }] },
  { key: 'inventory', items: [{ href: '/inventory' }, { href: '/inventory/movements' }] },
  { key: 'audience', items: [{ href: '/members' }, { href: '/music/requests' }] },
  { key: 'catalog', items: [{ href: '/music/songs' }, { href: '/music/catalog?tab=labels' }] },
];

describe('parseExpanded', () => {
  it('reads a comma-separated list', () => {
    expect(parseExpanded('audience,catalog')).toEqual(['audience', 'catalog']);
  });

  /**
   * The default is EVERYTHING CLOSED, and it is expressed as the absence of a
   * cookie rather than as a list naming every section — so a caller who has
   * never touched the sidebar carries no state at all.
   */
  it('answers empty for a cookie that is not there', () => {
    expect(parseExpanded(undefined)).toEqual([]);
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('')).toEqual([]);
  });

  /**
   * Sections come and go between blocks. A key left over from an older
   * deployment must not break the sidebar, and neither must whitespace or an
   * empty element from a hand-edited value: this cookie is not HttpOnly.
   */
  it('drops blanks and keeps unknown keys harmlessly', () => {
    expect(parseExpanded('audience,,  ,catalog')).toEqual(['audience', 'catalog']);
    expect(parseExpanded('  audience , retired_section ')).toEqual([
      'audience',
      'retired_section',
    ]);
  });

  it('de-duplicates rather than trusting what was written', () => {
    expect(parseExpanded('audience,audience')).toEqual(['audience']);
  });
});

describe('serializeExpanded', () => {
  it('round-trips through parseExpanded', () => {
    expect(parseExpanded(serializeExpanded(['audience', 'catalog']))).toEqual([
      'audience',
      'catalog',
    ]);
  });

  it('writes an empty string for nothing expanded', () => {
    expect(serializeExpanded([])).toBe('');
  });
});

describe('activeSectionKey', () => {
  it('finds the section holding an exact match', () => {
    expect(activeSectionKey(SECTIONS, '/members')).toBe('audience');
  });

  it('finds the section holding a nested route', () => {
    expect(activeSectionKey(SECTIONS, '/members/abc-123')).toBe('audience');
  });

  /**
   * `/app` must not light up for `/app-something`. The slash is what makes the
   * prefix a path segment rather than a string prefix — the same rule the link
   * highlighting has always used.
   */
  it('does not match a route that merely starts with the same letters', () => {
    expect(activeSectionKey(SECTIONS, '/appointments')).toBeNull();
  });

  /**
   * The query string is where Block 20b's three catalogue items differ from
   * each other, and it is not part of a pathname. Matching must ignore it, or
   * the catalogue section is never active.
   */
  it('matches an item whose href carries a query string', () => {
    expect(activeSectionKey(SECTIONS, '/music/catalog')).toBe('catalog');
  });

  /**
   * Both of these resolve correctly under ANY tie-break rule, because
   * `/music/requests` and `/music/songs` are siblings rather than one being a
   * prefix of the other. Kept because they are the real hrefs this block moves
   * between two sections, and a regression there is what somebody would
   * actually hit — but see the case below for the rule itself.
   */
  it('files the two /music routes under the sections that own them', () => {
    expect(activeSectionKey(SECTIONS, '/music/requests')).toBe('audience');
    expect(activeSectionKey(SECTIONS, '/music/songs')).toBe('catalog');
  });

  /**
   * THE LONGEST-MATCH RULE ITSELF, and this fixture is deliberately synthetic:
   * **no two sections in the real sidebar own hrefs in a prefix relationship
   * today.** The only prefix pair that exists — `/inventory` and
   * `/inventory/movements` — sits inside ONE section, where the tie-break
   * cannot change the answer.
   *
   * So the rule is defensive, and this is what makes it testable rather than
   * decorative: without a case that can only pass under longest-match, the
   * rule could be replaced by `Array.prototype.find` and every test would stay
   * green. One nav edit is all it would take for that to start mattering.
   */
  it('prefers the longest matching href when two sections genuinely overlap', () => {
    const overlapping = [
      { key: 'wide', items: [{ href: '/music' }] },
      { key: 'narrow', items: [{ href: '/music/songs' }] },
    ];
    expect(activeSectionKey(overlapping, '/music/songs')).toBe('narrow');
    expect(activeSectionKey(overlapping, '/music/songs/123')).toBe('narrow');
    // And the wide one still wins where it is the only match.
    expect(activeSectionKey(overlapping, '/music/other')).toBe('wide');
  });

  it('answers null for a path no section names', () => {
    expect(activeSectionKey(SECTIONS, '/nowhere')).toBeNull();
  });
});

describe('isSectionOpen', () => {
  it('opens a section the caller expanded', () => {
    expect(isSectionOpen('catalog', null, ['catalog'])).toBe(true);
  });

  it('opens the active section even when the caller never expanded it', () => {
    expect(isSectionOpen('audience', 'audience', [])).toBe(true);
  });

  it('leaves everything else closed', () => {
    expect(isSectionOpen('catalog', 'audience', [])).toBe(false);
  });

  it('closes everything when there is no cookie and no active section', () => {
    expect(isSectionOpen('catalog', null, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm run test -- tests/unit/nav-disclosure.test.ts
```

Expected: FAIL — the module does not exist, so the import throws.

- [ ] **Step 3: Write the module**

Create `src/lib/nav/disclosure.ts`:

```ts
/**
 * Block 20b, D4/D5. Which sidebar sections are open.
 *
 * PURE, AND IN ITS OWN FILE ON PURPOSE. The sidebar is a client component and
 * this repository has no component-testing library — vitest runs in `node`,
 * with no jsdom and no React Testing Library — so a decision left inside
 * `sidebar-nav.tsx` is checked by a browser or by nothing. The same split
 * `promotion-mapping.ts` exists for.
 */

/**
 * NOT HttpOnly, deliberately: the client writes it directly on every toggle,
 * which is why expanding a section costs no round trip. It carries no identity,
 * no permission and no secret — the worst a forged value can do is open a
 * section the caller could open by clicking.
 */
export const NAV_COOKIE = 'pulchatx_nav_open';

/** A year. A sidebar preference that expires is a sidebar preference nobody set. */
export const NAV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The expanded section keys, from the raw cookie value.
 *
 * Everything here is hostile input — the cookie is writable by the page — and
 * every unreadable shape becomes "nothing expanded" rather than an error. An
 * unknown key is KEPT rather than dropped: sections come and go between blocks,
 * and a key naming no current section simply matches nothing when
 * `isSectionOpen` asks. Dropping it here would silently forget a section that a
 * later deployment brings back.
 */
export function parseExpanded(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (key !== '') seen.add(key);
  }
  return [...seen];
}

export function serializeExpanded(keys: readonly string[]): string {
  return keys.join(',');
}

/**
 * The section holding the page the caller is on, or null.
 *
 * THE LONGEST MATCHING HREF WINS, and that is not decoration: `/music/requests`
 * belongs to Audience and `/music/songs` to Catalogue (Block 20b, D1), so a
 * first-match scan over a shared prefix would file the caller under whichever
 * section happened to be built first.
 *
 * The query string is stripped from each href before comparing. Catalogue's
 * three items differ from each other ONLY by `?tab=`, and a pathname never
 * carries one — matching on the raw href would leave that section permanently
 * inactive.
 */
export function activeSectionKey(
  sections: readonly { key: string; items: readonly { href: string }[] }[],
  pathname: string,
): string | null {
  let best: { key: string; length: number } | null = null;

  for (const section of sections) {
    for (const item of section.items) {
      const path = item.href.split('?')[0] ?? item.href;
      // The trailing slash is what makes this a path segment rather than a
      // string prefix: without it, /app lights up for /appointments too.
      const matches = pathname === path || pathname.startsWith(`${path}/`);
      if (matches && (best === null || path.length > best.length)) {
        best = { key: section.key, length: path.length };
      }
    }
  }

  return best?.key ?? null;
}

/**
 * A section is open when the caller expanded it, or when it is the one they are
 * standing in.
 *
 * The active section is never written to the cookie. It is open because of WHERE
 * THE CALLER IS, not because of anything they chose, and it has to go back to
 * whatever they did choose the moment they navigate away.
 */
export function isSectionOpen(
  key: string,
  activeKey: string | null,
  expanded: readonly string[],
): boolean {
  return key === activeKey || expanded.includes(key);
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npm run test -- tests/unit/nav-disclosure.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nav/disclosure.ts tests/unit/nav-disclosure.test.ts
git commit -F- <<'EOF'
feat(20b): which sections are open, as a function a test can call

The sidebar is a client component and this repository has no component-testing
library, so a decision left inside it is checked by a browser or by nothing.
This is the same split promotion-mapping.ts exists for.

Two rules earn their tests. The longest matching href wins, because
/music/requests is Audience's and /music/songs is Catalogue's after D1, and a
first-match scan over the shared prefix would file the caller under whichever
section was built first. And the query string is stripped before matching, since
Catalogue's three items differ only by ?tab= and a pathname never carries one --
matching raw hrefs would leave that section permanently inactive.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 3: The sidebar becomes a tree

**Files:**
- Modify: `src/components/layout/sidebar-nav.tsx`
- Modify: `src/lib/auth/shell.ts` (read the cookie, pass it down)
- Create: `tests/e2e/nav.ts`
- Modify: thirteen e2e specs, and `tests/e2e/dashboards.spec.ts`'s stale comment
- Test: `tests/e2e/nav-content.spec.ts` (extended with the disclosure journey)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `data-nav-section` from Task 1.
- Produces: `openNavSection(page: Page, name: string): Promise<void>` in
  `tests/e2e/nav.ts`.

**This task must land atomically.** The moment sections collapse, every spec that
clicks a sidebar link stops finding it — so the helper and the thirteen callers
ship in the same commit as the tree. A reviewer cannot sensibly approve the tree
while the suite is red.

The thirteen: `acceptance`, `deadline`, `deezer`, `filtered-draw`,
`inventory-flow`, `invitation-flow`, `members-flow`, `music-catalogue`,
`music-requests`, `record-dialog`, `roles-flow`, `shows`, `templates`.

**Why they break, stated so nobody chases it:** the mobile header
(`app-shell.tsx`, the `md:hidden` bar) renders every link of every section
flattened, and it stays in the DOM. It is `display:none` above 768px, so those
copies are outside the accessibility tree and `getByRole` never saw them — which
is why the suite has no strict-mode collisions today. Collapse the sidebar and
the only *visible* copy disappears too, so the locator matches nothing at all.

- [ ] **Step 1: Write the failing disclosure journey**

Append to `tests/e2e/nav-content.spec.ts` a second `test(...)`:

```ts
test('the sidebar remembers which sections a member opened', async ({ page }) => {
  // Sign in the same way the first test does.

  // D4. Everything closed except the section holding the current page. The
  // links are in the DOM inside a `hidden` panel, so assert on VISIBILITY --
  // toHaveCount would pass for a section that is merely collapsed.
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeHidden();

  // The section holding the landing page is open without anybody opening it.
  await expect(
    page.locator('[data-nav-section="dashboards"]').getByRole('link', { name: 'Audience overview' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Catalogue' }).click();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeVisible();

  // THE STEP THAT PROVES THE COOKIE. Everything above passes with pure client
  // state and no persistence at all; only a reload can tell the two apart.
  await page.reload();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeVisible();

  // And closing it is remembered too -- a one-way toggle would pass every
  // assertion above.
  await page.getByRole('button', { name: 'Catalogue' }).click();
  await page.reload();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeHidden();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/nav-content.spec.ts
```

Expected: FAIL on the first assertion — nothing collapses yet, so the Songs link
is visible where the test expects it hidden.

- [ ] **Step 3: Read the cookie in the shell**

In `src/lib/auth/shell.ts`, import `cookies` from `next/headers` and
`NAV_COOKIE`/`parseExpanded` from `@/lib/nav/disclosure`, then return the
expansions alongside what it already returns:

```ts
export async function getShellContext(): Promise<{
  sections: NavSection[];
  user: ShellUser;
  /**
   * Block 20b, D5. Which sections this caller has expanded, read on the SERVER
   * so the sidebar arrives in the right state. Read in the browser instead, it
   * would render open and collapse after hydration — a flash on every single
   * navigation, on every screen, since the shell wraps all of them.
   */
  expandedSections: string[];
}> {
```

and, beside the existing reads:

```ts
  const expandedSections = parseExpanded((await cookies()).get(NAV_COOKIE)?.value);
```

Both callers of `getShellContext` — the member layout and the platform console
layout — pass it into `AppShell`, which passes it to `SidebarNav`. Find them with
a search for `getShellContext`; there are exactly two.

`app-shell.tsx` gains `expandedSections: string[]` in its props and forwards it.

- [ ] **Step 4: Turn the heading into a disclosure**

Rewrite the section body of `src/components/layout/sidebar-nav.tsx`. The panel
stays in the DOM and is hidden when closed — `aria-controls` must point at an
element that exists, and a panel removed from the DOM would make the attribute a
dangling reference:

```tsx
export function SidebarNav({
  sections,
  expandedSections,
}: {
  sections: NavSection[];
  expandedSections: string[];
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<string[]>(expandedSections);
  const activeKey = activeSectionKey(sections, pathname);

  function toggle(key: string) {
    const next = expanded.includes(key)
      ? expanded.filter((k) => k !== key)
      : [...expanded, key];
    setExpanded(next);
    // Written straight to document.cookie rather than through a Server Action:
    // opening a section must not cost a round trip, and this value guards
    // nothing (see NAV_COOKIE's own comment). SameSite=Lax and a year's life.
    document.cookie = `${NAV_COOKIE}=${encodeURIComponent(serializeExpanded(next))}; path=/; max-age=${NAV_COOKIE_MAX_AGE}; samesite=lax`;
  }

  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => {
        const open = isSectionOpen(section.key, activeKey, expanded);
        const panelId = `nav-section-${section.key}`;
        return (
          <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => toggle(section.key)}
              aria-expanded={open}
              aria-controls={panelId}
              className="flex items-center justify-between gap-2 rounded-md px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wider text-sidebar-muted transition-colors hover:text-white"
            >
              {section.label}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
            {/* `flex` MUST be conditional. The `hidden` attribute works through
                the user-agent rule `[hidden] { display: none }`, and an author
                class setting `display: flex` beats it on specificity — so a
                panel carrying both is fully visible while announcing itself as
                collapsed. Found in implementation; the first draft of this plan
                had the bug. */}
            <div id={panelId} hidden={!open} className={cn('flex-col gap-1', open && 'flex')}>
              {section.items.map((item) => {
                /* the existing Link block, unchanged */
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
```

Import `useState` from `react` and the four names from `@/lib/nav/disclosure`.

**The active link's own highlighting is unchanged.** It still compares
`pathname` against `item.href` exactly as before — do not route it through
`activeSectionKey`, which answers a different question and strips query strings.

- [ ] **Step 5: Write the e2e helper**

Create `tests/e2e/nav.ts`:

```ts
import { expect, type Page } from '@playwright/test';

/**
 * Open a collapsed sidebar section so its links can be clicked.
 *
 * Block 20b, D4 made every section a disclosure, closed by default except the
 * one holding the current page — so a spec that reaches a screen by clicking a
 * sidebar link has to open its section first. THIRTEEN specs do that, and this
 * exists so the next navigation change costs one edit rather than thirteen.
 *
 * Idempotent: a section that is already open (because the caller is standing in
 * it) is left alone rather than toggled shut, which is what a bare click would
 * do.
 */
export async function openNavSection(page: Page, name: string): Promise<void> {
  const heading = page.getByRole('button', { name, exact: true });
  await expect(heading).toBeVisible();
  if ((await heading.getAttribute('aria-expanded')) !== 'true') {
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
  }
}
```

- [ ] **Step 6: Call it from the thirteen**

In each spec, immediately before a `getByRole('link', { name: … })` that targets
a sidebar link, add the matching call — for example, in
`tests/e2e/members-flow.spec.ts` before the click on Members:

```ts
await openNavSection(page, 'Audience');
await page.getByRole('link', { name: 'Members' }).click();
```

The section name for each link, in English, since the suite is pinned to
`en-US`:

**These are SECTION labels, read from `messages/en.json`'s `nav` object — not
item labels, and the two differ where you would least expect.** The section is
`Inventory` while the item inside it is `Stock`; the section is `Catalog`
without the British `-ue`. Verify any name you are unsure of against that file
rather than against this table.

| Link | Section |
|---|---|
| Members, Participations, Programmes, Requests | `Audience` |
| Songs, Artists, Record labels, Genres, Albums, Maintenance | `Catalog` |
| Stock, Movements | `Inventory` |
| Promotions, Pickups | `Promotions` |
| Messages, WhatsApp | `Templates` |
| Team, Roles | `Organization` |
| My reports | `Reports` |
| Audit trail | `Administration` |
| Organizations, Stations, Contact requests | `Platform` |
| Audience overview, Music overview, Promotions overview | `Dashboards` |
| My stations | `Overview` |

Some clicks will already be inside the active section and need no call; the
helper is idempotent, so adding it there is harmless rather than wrong. **Run
each spec after editing it** rather than editing all thirteen and running once —
a failure then names its own file.

- [ ] **Step 7: Fix the stale comment**

`tests/e2e/dashboards.spec.ts` carries a comment stating the section heading is a
plain `<p>` and that its selector was therefore never ambiguous. Rewrite it: the
heading is now a `<button>`, the selector it describes is on a **link** and still
unambiguous, and the reason it was ever a question — a section and an item
spelling one word — is unchanged.

- [ ] **Step 8: Run the whole e2e suite**

```bash
npm run db:reset && npm run seed:branding && npm run test:e2e
```

Expected: PASS, every spec. This is the gate that proves the thirteen were all
found — a missed one fails here.

- [ ] **Step 9: Commit**

```bash
git add src/components/layout/sidebar-nav.tsx src/components/layout/app-shell.tsx src/lib/auth/shell.ts tests/e2e/
git commit -F- <<'EOF'
feat(20b): the sidebar becomes a tree, closed except where you are standing

Twenty-six links open at once is a wall, and the shape of the product is
invisible inside it. Every section is now a disclosure: closed by default, the
one holding the current page always open, and what a member opens remembered in
a cookie read on the SERVER -- read in the browser it would render open and
collapse after hydration, a flash on every navigation of every screen.

The panel stays in the DOM and is `hidden` when closed, because aria-controls
must point at something that exists.

Thirteen specs reach screens by clicking sidebar links and all thirteen ship in
this commit, through one helper rather than thirteen edits. They break for a
reason worth writing down: the md:hidden mobile header renders every link
flattened and keeps them in the DOM, but display:none puts them outside the
accessibility tree -- which is why getByRole never collided with them, and why
collapsing the sidebar leaves the locator matching nothing at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: Signing in lands on the audience dashboard

**Files:**
- Modify: `src/middleware.ts` (`MEMBER_HOME`, line ~44)
- Modify: `src/app/(auth)/login/page.tsx` (line ~44)
- Modify: `src/app/(auth)/change-password/page.tsx` (line ~43)
- Test: `tests/e2e/login.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `MEMBER_HOME` exported from `src/lib/routes.ts` (new file), imported
  by all three.

**Task 3's disclosure journey asserts which section opens itself on landing, and
this task moves the landing.** Before this task, the home is `/app`, which is
Overview's own item, so that journey asserts `overview` / `My stations`. After
it, the home is `/dashboards/audience` and the section that opens itself is
`dashboards` / `Audience overview`. **Update that assertion in
`tests/e2e/nav-content.spec.ts` as part of this task** — it is not a separate
concern, it is the same fact seen from the other end, and leaving it will fail
the suite.

- [ ] **Step 1: Write the failing assertion**

In `tests/e2e/login.spec.ts`, find the test that signs a member in and assert
where they land:

```ts
  // Block 20b, D6. Signing in lands on the audience dashboard, not on
  // /app. A member who cannot reach the dashboard is redirected onward to
  // /app by the page itself, so this asserts the ordinary case.
  await expect(page).toHaveURL(/\/dashboards\/audience$/);
```

If the existing test already asserts a URL after sign-in, change that assertion
rather than adding a second one.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/login.spec.ts
```

Expected: FAIL — the URL is `/app`.

- [ ] **Step 3: Create the constant**

Create `src/lib/routes.ts`:

```ts
/**
 * Where a signed-in member lands.
 *
 * Block 20b, D6. This was spelled in three places — `MEMBER_HOME` in
 * middleware.ts, the sign-in redirect, and the redirect after a forced password
 * change — which is three copies of one fact and three places for it to drift.
 *
 * THERE IS NO REDIRECT LOOP, and this was checked rather than assumed:
 * /dashboards/audience redirects to /app for a caller who can reach no Station
 * with the permission it needs (its page.tsx, `if (!first) redirect('/app')`),
 * so a member who cannot see the dashboard lands exactly where they land today.
 */
export const MEMBER_HOME = '/dashboards/audience';
```

- [ ] **Step 4: Use it in all three places**

In `src/middleware.ts`, delete the local `const MEMBER_HOME = '/app';` and import
the new one. In `src/app/(auth)/login/page.tsx` and
`src/app/(auth)/change-password/page.tsx`, replace the `'/app'` literals in their
`redirect(...)` calls with `MEMBER_HOME`.

Leave every OTHER `'/app'` in the codebase alone — the nav link, and the
`redirect('/app')` calls inside individual pages that bounce a caller lacking a
permission. Those mean "the page that always works", which is a different fact
from "where a member lands", and collapsing them would be wrong.

- [ ] **Step 5: Run the tests**

```bash
npm run typecheck
npx playwright test tests/e2e/login.spec.ts tests/e2e/signout.spec.ts tests/e2e/provisioning-flow.spec.ts tests/e2e/roles-flow.spec.ts
```

Expected: PASS. Those four navigate to `/app` explicitly or assert sign-in
behaviour, and are where a wrong constant would show first.

- [ ] **Step 6: Commit**

```bash
git add src/lib/routes.ts src/middleware.ts "src/app/(auth)/login/page.tsx" "src/app/(auth)/change-password/page.tsx" tests/e2e/login.spec.ts
git commit -F- <<'EOF'
feat(20b): signing in lands on the audience dashboard

Where a member lands was spelled in three files -- middleware.ts, the sign-in
redirect and the redirect after a forced password change -- which is three
copies of one fact. It becomes one constant, and its value becomes the audience
dashboard.

No redirect loop, checked rather than assumed: /dashboards/audience already
redirects to /app for a caller who can reach no Station with the permission it
needs, so a member who cannot see it lands exactly where they land today.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: The gates, the documentation, and the push

**Files:**
- Modify: whichever file under `docs/` names the sidebar's sections or their
  order — Step 1 finds it. There may be none, and that is a valid outcome.
- `docs/WIDGET.md` is about the embeddable widget and is not touched by this
  block.

- [ ] **Step 1: Find and update any documentation that describes the navigation**

```bash
grep -rln "Relat\|sidebar\|navigation" docs/*.md | head -20
```

Read what the search finds. Update anything that names the sidebar's sections,
their order, or where Requests lives — the same rule Block 20a applied to
`docs/WIDGET.md`: a living operator reference that describes a structure the
product no longer has sends somebody looking in the wrong place. If nothing
names it, say so in the report rather than inventing a document.

- [ ] **Step 2: Run every gate, in the order that works**

```bash
npm run typecheck
npm run lint
npm run test
npm run db:reset
npm run db:test
npm run seed:branding
npm run test:e2e
npm run test:isolation
```

`db:test` before the e2e and isolation suites, never after. Report the actual
output of any failure rather than re-running until it passes. On an incomplete
isolation run, re-run once from a clean database; if the same file drops out
twice, stop and report.

- [ ] **Step 3: Commit any documentation change**

```bash
git add docs/
git commit -F- <<'EOF'
docs(20b): the sidebar's order, where it was written down

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

Skip this step entirely if Step 1 found nothing to change; an empty commit says
a document was updated when none was.

- [ ] **Step 4: Push**

```bash
git push
```

This adds to PR #65, which is open from this branch. Do not open a second one.

- [ ] **Step 5: Report**

State, in the final report:

1. A one-line result for each of the eight gates.
2. Whether the isolation suite needed a re-run, and which file dropped out if so.
3. Which documentation Step 1 found, and what changed — or that nothing named
   the navigation.
4. That the thirteen specs were each run individually as they were edited, and
   the full suite afterwards.
