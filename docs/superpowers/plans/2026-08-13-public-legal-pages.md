# Public Legal Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `/privacy`, `/delete-data` and `/terms` as public pages in
English, Portuguese and Spanish, with a deletion-request form that records a
request and returns a quotable protocol.

**Architecture:** The legal text lives in typed content modules — one per
document per locale — rendered by a single component that knows the only markup
vocabulary a legal document needs. The three routes join the existing `(public)`
group and the middleware's explicit public list. The deletion form reuses
`/contato`'s path end to end (Server Action → zod schema → service with hashed-IP
rate limiting → mailer), differing only in that it writes to its own table and
returns a protocol.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions),
React 19, next-intl, Supabase Postgres (pgTAP), Playwright, Vitest, zod.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-13-public-legal-pages-design.md`.
  Every decision traces to a D-number in its §2.
- **Branch:** `block-19-whatsapp-entry`, already checked out. Do not create a
  branch, do not merge. PR #65 is open from it; these commits join it.
- **The product is spelled `PulchatX`.** The owner's source text writes
  "PulChatX" throughout and it is wrong. Correct it everywhere, in all three
  languages, including inside prose.
- **Code, comments and commit messages in English.** Interface labels go in
  `messages/pt.json`, `en.json` and `es.json` — all three, always;
  `tests/unit/i18n/catalogue.test.ts` compares them. **The legal documents do
  NOT go in those files** (D1) — they are content modules.
- **Message keys are single-quoted literals at the call site, never composed.**
  `tests/unit/i18n/usage.test.ts` reads the AST for literal keys only.
- **The e2e suite runs in English** — `playwright.config.ts` pins
  `locale: 'en-US'`.
- **The locales are `en`, `pt`, `es`, and the default is `en`**
  (`src/i18n/locales.ts`).
- **The form records; it never erases** (D3). Nothing in this plan calls
  `anonymize_member` or any erasure path.
- **Gate order:** typecheck, lint, unit, `db:reset`, `db:test`,
  `seed:branding`, e2e, isolation. `db:test` before the e2e and isolation
  suites, never after.
- **The isolation suite crashes about two runs in five** from a documented
  flake. On an incomplete run, re-run **once** from a clean database; if the
  **same file** drops out twice, stop and report. Never weaken
  `scripts/verify-isolation-suite.mjs`.
- **Do not dispatch sub-agents.** Run long suites in the FOREGROUND with a
  generous timeout.
- Commit after every task. Do not push until the final task.

---

## File Structure

**Created:**

- `src/content/legal/types.ts` — the document structure every module exports.
  Task 1.
- `src/content/legal/render.tsx` — the only file that knows markup. Task 1.
- `src/content/legal/privacy.{en,pt,es}.ts` — Task 1.
- `src/content/legal/terms.{en,pt,es}.ts`, `src/content/legal/delete-data.{en,pt,es}.ts` — Task 2.
- `src/content/legal/index.ts` — resolves a document and locale to a module.
  Task 1.
- `tests/unit/legal-content.test.ts` — the structural test. Task 1.
- `src/app/(public)/privacy/page.tsx`, `terms/page.tsx`, `delete-data/page.tsx` — Task 3.
- `src/app/(public)/public-header.tsx` — Task 3.
- `tests/e2e/legal-pages.spec.ts` — Task 3, extended in Task 5.
- `supabase/migrations/0188_data_deletion_requests.sql` — Task 4.
- `supabase/tests/50_data_deletion_requests.test.sql` — Task 4.
- `src/schemas/data-deletion.ts`, `src/services/data-deletion.ts` — Task 5.
- `src/app/(admin)/admin/data-deletion-requests/page.tsx` — Task 6.

**Modified:**

- `src/app/(public)/layout.tsx` — renders the header. Task 3.
- `src/middleware.ts` — `PUBLIC_PATHS` gains the three routes. Task 3.
- `messages/{pt,en,es}.json` — interface labels only. Tasks 3, 5, 6.
- `src/lib/auth/shell.ts` — the console nav item. Task 6.

---

## Task 1: The document structure, the renderer, and the privacy policy

**Files:**
- Create: `src/content/legal/types.ts`, `render.tsx`, `index.ts`,
  `privacy.en.ts`, `privacy.pt.ts`, `privacy.es.ts`
- Test: `tests/unit/legal-content.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 2 and 3:
  - `LegalDocument`, `LegalSection`, `LegalBlock` types
  - `LegalArticle({ document }: { document: LegalDocument })` — the renderer
  - `legalDocument(slug: LegalSlug, locale: Locale): LegalDocument`
  - `LegalSlug = 'privacy' | 'terms' | 'delete-data'`

**The owner's source text is at `<workspace>/legal-source-pt.md`** — the three
documents in Portuguese, already corrected to `PulchatX`. It is the authority
for the Portuguese and the source for the two translations. Read it before
writing anything.

- [ ] **Step 1: Write the failing structural test**

Create `tests/unit/legal-content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES } from '@/i18n/locales';
import { LEGAL_SLUGS, legalDocument } from '@/content/legal';

/**
 * What this catches, and why a translation review would not.
 *
 * Three copies of one legal document drift by ONE CLAUSE at a time: a
 * translator merges two sections, or drops a list a lawyer added last month,
 * and every page still renders. Comparing the SHAPE of the three — how many
 * sections, in what order — makes that a red test rather than a discovery in a
 * regulator's letter. It cannot check meaning, and does not pretend to.
 */
describe('every legal document has the same shape in every language', () => {
  for (const slug of LEGAL_SLUGS) {
    it(`${slug} has the same section count in all three locales`, () => {
      const counts = AVAILABLE_LOCALES.map((l) => legalDocument(slug, l).sections.length);
      expect(new Set(counts).size).toBe(1);
    });

    /**
     * Headings differ by language, so identity is compared by the section's
     * own stable `id` — which is also what an anchor link in the policy points
     * at, so a drift here breaks a citation as well as the translation.
     */
    it(`${slug} has the same section ids, in the same order, in all three locales`, () => {
      const ids = AVAILABLE_LOCALES.map((l) =>
        legalDocument(slug, l).sections.map((s) => s.id).join(','),
      );
      expect(new Set(ids).size).toBe(1);
    });

    it(`${slug} carries a title and an updated date in every locale`, () => {
      for (const locale of AVAILABLE_LOCALES) {
        const doc = legalDocument(slug, locale);
        expect(doc.title.trim()).not.toBe('');
        expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});

describe('the product name', () => {
  /**
   * The owner's source text spells it "PulChatX" throughout and the product is
   * "PulchatX". This is the one spelling error that would ship on a page whose
   * whole purpose is to be quoted.
   */
  it('is never spelled with a capital C, in any document or language', () => {
    for (const slug of LEGAL_SLUGS) {
      for (const locale of AVAILABLE_LOCALES) {
        expect(JSON.stringify(legalDocument(slug, locale))).not.toMatch(/PulChatX/);
      }
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test -- tests/unit/legal-content.test.ts
```

Expected: FAIL — `@/content/legal` does not exist, so the import throws.

- [ ] **Step 3: Write the types**

Create `src/content/legal/types.ts`:

```ts
/**
 * The whole vocabulary a legal document needs, and deliberately no more.
 *
 * NO ARBITRARY HTML AND NO RICH-TEXT PARSER (spec §3.2). These three pages are
 * the ones where what is displayed must equal what was written, and a renderer
 * that can be handed markup is a renderer nobody can audit. Headings,
 * paragraphs, lists and links is the entire grammar of the owner's text.
 */
export interface LegalLink {
  readonly label: string;
  readonly href: string;
}

export type LegalBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  /** A paragraph whose whole point is the address it carries, e.g. the deletion page. */
  | { readonly kind: 'link'; readonly text: string; readonly link: LegalLink };

export interface LegalSection {
  /**
   * Stable across languages, and NOT derived from the heading — the heading is
   * translated and the id is what the structural test compares and what an
   * anchor cites.
   */
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  readonly title: string;
  /** ISO date. Formatted per locale at render time rather than written as prose. */
  readonly updated: string;
  readonly intro?: readonly LegalBlock[];
  readonly sections: readonly LegalSection[];
}
```

- [ ] **Step 4: Write the resolver**

Create `src/content/legal/index.ts` exporting `LEGAL_SLUGS`, the `LegalSlug`
type, and `legalDocument(slug, locale)`. Import the nine modules statically —
**not** through a dynamic path built from the arguments: a template-literal
import is invisible to the bundler and to `tsc`, and a missing file would become
a runtime 500 on a page a regulator is reading. A lookup object keyed by slug and
locale gives the same brevity and fails at compile time.

Until Task 2 lands, the object holds only `privacy`; the test iterates
`LEGAL_SLUGS`, so keep that constant limited to what exists and widen it in
Task 2.

- [ ] **Step 5: Write the renderer**

Create `src/content/legal/render.tsx`:

```tsx
import type { LegalBlock, LegalDocument } from './types';

/**
 * The only file in this feature that knows markup.
 *
 * The `<main>` wrapper belongs to the PAGE, not here: /delete-data puts a form
 * beside this article, and only the page knows that.
 */
function Block({ block }: { block: LegalBlock }) {
  if (block.kind === 'list') {
    return (
      <ul className="ml-5 flex list-disc flex-col gap-1">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === 'link') {
    return (
      <p>
        {block.text}{' '}
        <a href={block.link.href} className="text-primary underline underline-offset-2">
          {block.link.label}
        </a>
      </p>
    );
  }
  return <p>{block.text}</p>;
}

export function LegalArticle({
  document,
  locale,
}: {
  document: LegalDocument;
  locale: string;
}) {
  // Formatted here rather than written into the prose, so one ISO date in the
  // content serves three languages and cannot disagree with itself.
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
    new Date(`${document.updated}T00:00:00Z`),
  );

  return (
    <article className="flex flex-col gap-6 text-sm leading-relaxed">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{document.title}</h1>
        <p className="text-muted-foreground">{updated}</p>
      </header>

      {document.intro?.map((block, i) => <Block key={i} block={block} />)}

      {document.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          <h2 id={section.id} className="text-lg font-semibold">
            {section.heading}
          </h2>
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </section>
      ))}
    </article>
  );
}
```

The index keys on `block` content where it is stable (list items) and on
position where it is not — a paragraph's text is the only thing identifying it,
and paragraphs are never reordered at runtime because the document is static.

- [ ] **Step 6: Write the privacy policy in three languages**

Create `privacy.pt.ts` from the source file's first document, section by
section, ids in `kebab-case` naming the subject (`about`, `data`, `purpose`,
`meta`, `sharing`, `security`, `retention`, `rights`, `deletion`,
`promotions`, `changes`, `contact`).

Then `privacy.en.ts` and `privacy.es.ts` — **translations of the same sections
in the same order with the same ids**, not new drafts. That is what makes the
three diffable when the policy is amended, and it is what the structural test
enforces.

Every mention of the product is `PulchatX`.

- [ ] **Step 7: Run the test and watch it pass**

```bash
npm run test -- tests/unit/legal-content.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/content/legal tests/unit/legal-content.test.ts
git commit -F- <<'EOF'
feat: legal documents as content, and a renderer with one grammar

The text lives in typed modules rather than the message catalogues. A policy
changes AS a document -- a git diff of one amended clause is readable, where the
same edit inside a 120 KB JSON catalogue is not -- and next-intl loads a
catalogue per request on every page of the product, not only these.

The renderer knows headings, paragraphs, lists and links, and nothing else. On
the three pages where what is displayed must equal what was written, a renderer
that accepts markup is a renderer nobody can audit.

The structural test compares the SHAPE of the three languages, not their
meaning: three copies of a document drift one clause at a time, and comparing
section ids and their order turns that into a red test instead of a discovery in
a regulator's letter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: The terms and the deletion document

**Files:**
- Create: `src/content/legal/terms.{en,pt,es}.ts`,
  `src/content/legal/delete-data.{en,pt,es}.ts`
- Modify: `src/content/legal/index.ts` (widen `LEGAL_SLUGS` and the lookup)

**Interfaces:**
- Consumes: `LegalDocument` and the resolver from Task 1.
- Produces: `LEGAL_SLUGS` covering all three documents.

- [ ] **Step 1: Widen the slugs and watch the test fail**

Add `'terms'` and `'delete-data'` to `LEGAL_SLUGS` before writing the modules,
then:

```bash
npm run test -- tests/unit/legal-content.test.ts
```

Expected: FAIL — the lookup has no entry for the new slugs. That failure is the
proof the structural test actually covers a document rather than only the one it
was written against.

- [ ] **Step 2: Write the terms in three languages**

From the source file's third document. Section ids: `service`, `use`,
`song-requests`, `promotions`, `data-protection`, `retention`,
`third-parties`, `stations`, `availability`, `intellectual-property`,
`changes`, `rights`.

- [ ] **Step 3: Write the deletion document in three languages**

From the source file's second document — **the prose only**. The form itself is
Task 5 and is not content. Section ids: `how`, `after`, `what-data`,
`stations`, `meta`, `inactivity`, `protection`.

The section the source calls "Formulário de solicitação" is **not** a content
section: it describes the form, and the form will be on the page below the
article. Writing it as prose would leave the page saying "preencha o formulário
abaixo" twice.

- [ ] **Step 4: Run the test and watch it pass**

```bash
npm run test -- tests/unit/legal-content.test.ts
npm run typecheck
npm run lint
```

Expected: PASS, including the product-name assertion across all nine modules.

- [ ] **Step 5: Commit**

```bash
git add src/content/legal
git commit -F- <<'EOF'
feat: the terms and the deletion document, in three languages

The deletion document carries its prose only. The source's "Formulário de
solicitação" section is not content -- it describes the form, which sits below
the article, and writing it as prose would leave the page telling the reader to
fill in the form below twice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 3: The three routes, the public header, and reachability

**Files:**
- Create: `src/app/(public)/privacy/page.tsx`, `terms/page.tsx`,
  `delete-data/page.tsx`, `public-header.tsx`
- Modify: `src/app/(public)/layout.tsx`, `src/middleware.ts`,
  `messages/{pt,en,es}.json`
- Test: `tests/e2e/legal-pages.spec.ts`

**Interfaces:**
- Consumes: `legalDocument`, `LegalArticle` from Tasks 1 and 2.
- Produces: the three addresses, and `PublicHeader`.

- [ ] **Step 1: Write the failing e2e**

Create `tests/e2e/legal-pages.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

/**
 * NO SIGN-IN ANYWHERE IN THIS FILE, and that is the point.
 *
 * PUBLIC_PATHS in src/middleware.ts is an explicit list, and a path missing
 * from it sends a signed-out visitor to /login. Asserting these pages while
 * signed in would pass with the middleware misconfigured and tell us nothing
 * about the listener who will actually open them -- from a link inside
 * WhatsApp, with no account.
 */
for (const { path, heading } of [
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Service' },
  { path: '/delete-data', heading: 'Data Deletion Request' },
]) {
  test(`${path} is readable with no session at all`, async ({ page }) => {
    await page.goto(path);

    // Not redirected to the sign-in screen.
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

    // Semantic structure a legal document needs, asserted rather than assumed.
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('article')).toBeVisible();
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(3);

    // The header links the three documents to each other and nothing else.
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
  });
}

test('a legal page offers no way into the signed-in product', async ({ page }) => {
  await page.goto('/privacy');
  // The listener reading this has no account. A link into the app would be a
  // dead end that looks like a door.
  await expect(page.getByRole('link', { name: 'My stations' })).toHaveCount(0);
});
```

The English headings must match what `privacy.en.ts`, `terms.en.ts` and
`delete-data.en.ts` actually carry — read them rather than trusting these
strings, and correct the test to the content, not the content to the test.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/legal-pages.spec.ts
```

Expected: FAIL — the routes do not exist, so `/privacy` 404s or redirects.

- [ ] **Step 3: Add the routes to the middleware**

In `src/middleware.ts`, extend `PUBLIC_PATHS`:

```ts
const PUBLIC_PATHS = [
  '/contato',
  // The three pages a listener reaches from a link inside WhatsApp, with no
  // account. Meta requires the first two published before it reviews an
  // integration, and the LGPD requires them regardless.
  '/privacy',
  '/delete-data',
  '/terms',
  '/login',
  '/forgot-password',
  '/auth/callback',
  '/api/health',
];
```

- [ ] **Step 4: Write the public header**

Create `src/app/(public)/public-header.tsx`: the PulchatX wordmark, links to the
three documents, and the language selector. **No link into the authenticated
product** — a listener reading this has no account, and a link there is a dead
end that looks like a door.

For the language selector, reuse `setLocaleAction` from
`src/app/(app)/locale-actions.ts` — read it first. Its own comment records that
it writes the cookie first and works for somebody with no profile, which is
exactly this case. If it turns out to throw when unauthenticated, stop and
report rather than writing a second one.

- [ ] **Step 5: Render the header in the public layout**

`src/app/(public)/layout.tsx` keeps its column and renders `PublicHeader` above
`{children}`. `/contato` shares this layout and gains the header too, which is an
improvement rather than a side effect — say so in the commit.

- [ ] **Step 6: Write the three pages**

Each is a Server Component: resolve the locale with `getLocale()`, fetch the
document with `legalDocument(slug, locale)`, and render
`<main><LegalArticle document={doc} /></main>`.

`/delete-data` renders the article and, below it, a placeholder heading for the
form — Task 5 fills it. Do not stub a fake form; an input that does nothing on a
page about legal rights is worse than no input.

Add the header's labels to all three catalogues under the existing `public`
namespace.

- [ ] **Step 7: Run the gates that see this**

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
npx playwright test tests/e2e/legal-pages.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)" src/middleware.ts messages/ tests/e2e/legal-pages.spec.ts
git commit -F- <<'EOF'
feat: /privacy, /terms and /delete-data, reachable with no account

PUBLIC_PATHS is an explicit list and a path missing from it sends a signed-out
visitor to /login -- so the journeys sign in nowhere. Asserting these pages
while signed in would pass with the middleware misconfigured and prove nothing
about the listener who opens them from a link inside WhatsApp.

The public layout gains a header: the wordmark, the three documents, and a
language selector. No link into the signed-in product -- the reader has no
account, and a link there is a dead end that looks like a door. /contato shares
the layout and gains it too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: The table and its protocol

**Files:**
- Create: `supabase/migrations/0188_data_deletion_requests.sql`,
  `supabase/tests/50_data_deletion_requests.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 5 and 6:
  - `data_deletion_requests` with `protocol text not null unique`
  - `data_deletion_request_status` enum: `'new' | 'verifying' | 'completed' | 'refused'`
  - `public.new_deletion_protocol() returns text`

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/50_data_deletion_requests.test.sql`, following the style
of `supabase/tests/42_widget_promotions.test.sql` — `begin; select plan(N);`,
numbered sections explaining *why*, `select * from finish(); rollback;`.

Assert:

1. `new_deletion_protocol()` returns something matching `^PX-[0-9A-Z]{4}-[0-9A-Z]{4}$`.
2. It **never emits an ambiguous character** — call it 200 times and assert no
   result matches `[O0I1]`. A person reads this down a telephone; `O` against
   `0` is the failure that wastes their second call.
3. Two calls return different values.
4. An insert with no `protocol` gets one from the column default.
5. `protocol` is unique — a duplicate insert raises `23505`.
6. **`anon` may not read the table.** It holds a name, a telephone and an
   e-mail. Follow how `29_artwork_bucket.test.sql` and the contact-request tests
   express a grant assertion; if `contact_requests` has no such test, say so in
   your report and assert it here from first principles.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset
npm run db:test
```

Expected: FAIL — neither the function nor the table exists.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0188_data_deletion_requests.sql`. Model the table on
`contact_requests` (`0004_audit_and_contact.sql:26-37`) — read it first — and
carry these decisions in comments:

```sql
-- supabase/migrations/0188_data_deletion_requests.sql

-- The LGPD deletion request, and the protocol a person can read aloud.
--
-- NOT contact_requests WITH A FLAG. That table is where somebody asks about
-- buying the product; this one is a statutory obligation with a clock on it.
-- Sharing would put a legal deadline in the same inbox as a sales lead, and
-- would force the protocol to be the row's uuid -- which nobody can dictate
-- down a telephone, which is the one thing a protocol exists for.
--
-- THE ALPHABET HAS THE AMBIGUOUS CHARACTERS REMOVED: no O against 0, no I
-- against 1. The whole point of this string is that it survives being read
-- aloud and written down by somebody who is upset.
--
-- NOT A SEQUENCE, though a sequence would be easier still to dictate: a
-- sequential protocol publishes how many people have asked to be deleted.
```

Then: the status enum, `new_deletion_protocol()` (32-symbol alphabet
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, eight characters, formatted
`PX-XXXX-XXXX`), the table with `protocol text not null unique default public.new_deletion_protocol()`,
the same `ip_hash`/`created_at`/`updated_at` columns `contact_requests` carries,
`enable row level security`, and grants that let `service_role` write and
`authenticated` read nothing directly — the console screen reads through a
platform-admin path, following how `contact_requests` is exposed. Read
`src/app/(admin)/admin/contact-requests/page.tsx` to see which client it uses,
and match it.

- [ ] **Step 4: Run the pgTAP and watch it pass**

```bash
npm run db:reset
npm run db:test
```

Expected: PASS, including every pre-existing assertion.

- [ ] **Step 5: Regenerate the types**

```bash
npm run db:types
```

Expected: `src/lib/supabase/database.types.ts` gains the table and the function.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0188_data_deletion_requests.sql supabase/tests/50_data_deletion_requests.test.sql src/lib/supabase/database.types.ts
git commit -F- <<'EOF'
feat: the deletion request, and a protocol somebody can read aloud

Its own table rather than a flag on contact_requests: one is a sales enquiry,
the other a statutory obligation with a clock on it, and sharing would force the
protocol to be a uuid -- which nobody can dictate, which is the one thing a
protocol is for.

The alphabet drops the ambiguous characters, because the string has to survive
being read down a telephone by somebody who is upset. It is not a sequence,
though a sequence would dictate even better: that would publish how many people
have asked to be deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: The form

**Files:**
- Create: `src/schemas/data-deletion.ts`, `src/services/data-deletion.ts`
- Modify: `src/app/(public)/delete-data/page.tsx`, `messages/{pt,en,es}.json`
- Test: `tests/e2e/legal-pages.spec.ts`

**Interfaces:**
- Consumes: `data_deletion_requests` from Task 4.
- Produces:
  - `dataDeletionRequestSchema` / `DataDeletionRequestInput`
  - `submitDataDeletionRequest(input, ipAddress): Promise<string>` — returns the protocol

- [ ] **Step 1: Write the failing e2e**

Append to `tests/e2e/legal-pages.spec.ts`:

```ts
test('a deletion request is recorded and answered with a protocol', async ({ page }) => {
  await page.goto('/delete-data');

  await page.getByTestId('deletion-name').fill('Maria Teste');
  await page.getByTestId('deletion-phone').fill('+5511999990000');
  await page.getByTestId('deletion-email').fill('maria.teste@example.com');
  await page.getByTestId('deletion-station').fill('Rádio Teste');
  await page.getByTestId('deletion-notes').fill('Quero meus dados apagados.');
  await page.getByTestId('deletion-confirm').check();
  await page.getByTestId('deletion-submit').click();

  // The receipt, not a thank-you: the protocol is the thing they were promised.
  const protocol = page.getByTestId('deletion-protocol');
  await expect(protocol).toBeVisible();
  await expect(protocol).toHaveText(/^PX-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test('a deletion request without the confirmation is refused', async ({ page }) => {
  await page.goto('/delete-data');
  await page.getByTestId('deletion-name').fill('Maria Teste');
  await page.getByTestId('deletion-phone').fill('+5511999990001');
  await page.getByTestId('deletion-email').fill('maria2@example.com');
  // The confirmation box is deliberately NOT checked. It is the difference
  // between typing a telephone number and stating a request.
  await page.getByTestId('deletion-submit').click();

  await expect(page.getByTestId('deletion-protocol')).toHaveCount(0);
});
```

Then assert the row reached the database, reading it back with an admin client
the way `tests/e2e/widget.spec.ts` already does for `music_requests` — the screen
saying a protocol is the page's opinion of what happened; the row is the fact.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/legal-pages.spec.ts -g "protocol"
```

Expected: FAIL — no form on the page, so `deletion-name` is not found.

- [ ] **Step 3: Write the schema**

Create `src/schemas/data-deletion.ts`, modelled on `src/schemas/contact.ts`:
`name` (2–120), `phone` (required, ≤40), `email` (required, valid), `station`
(optional, ≤120), `notes` (optional, ≤2000), and `confirmed` — which must be
literally `true`. The checkbox posts nothing when unchecked, so the schema reads
an absent key as a refusal rather than a default.

- [ ] **Step 4: Write the service**

Create `src/services/data-deletion.ts`, modelled on
`src/services/contact-requests.ts` — read it first and reuse its shape:
`hashIpAddress`, the `PostgresRateLimiter` at **five per hour**, the insert
through the service client, the `logger.info` on success, and the best-effort
mailer guarded by `env.MAIL_FROM` inside its own try/catch, because a failed
notification must never lose a request.

It differs in one way: it returns the `protocol` the insert generated, selected
back from the inserted row. Comment that the protocol is the database's, never
the application's — two sources for one identifier is two identifiers.

- [ ] **Step 5: Write the form**

In `src/app/(public)/delete-data/page.tsx`, below the article: a Server Action
following `/contato`'s exactly — parse, get the IP from `x-forwarded-for`,
`redirect` outside the `catch` (its comment there explains why: `redirect`
signals by throwing, so inside the catch a success is reported as a failure),
and carry the protocol back in the query string.

When the query string carries a protocol, the page renders the receipt instead
of the form: the protocol under `data-testid="deletion-protocol"`, what happens
next, and that no fee is charged.

Give every control the `data-testid` Step 1 uses. Copy goes in all three
catalogues.

- [ ] **Step 6: Run the gates that see this**

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
npx playwright test tests/e2e/legal-pages.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/data-deletion.ts src/services/data-deletion.ts "src/app/(public)/delete-data" messages/ tests/e2e/legal-pages.spec.ts
git commit -F- <<'EOF'
feat: the deletion form records a request and answers with its protocol

The path /contato established, reused end to end: Server Action, zod schema,
hashed-IP rate limit, best-effort notification. It differs in returning the
protocol the database generated -- never one the application invented, because
two sources for one identifier is two identifiers.

The confirmation box is required by the schema rather than by the markup: an
unchecked box posts nothing, so an absent key is read as a refusal. It is the
difference between somebody typing a telephone number and somebody stating a
request.

The form records. It erases nothing -- a public form that deleted on submission
would let anybody erase anybody's record by typing their telephone number.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 6: The screen behind it

**Files:**
- Create: `src/app/(admin)/admin/data-deletion-requests/page.tsx`
- Modify: `src/lib/auth/shell.ts`, `messages/{pt,en,es}.json`

**Interfaces:**
- Consumes: `data_deletion_requests` from Task 4.
- Produces: `/admin/data-deletion-requests`, and a nav item in the Plataforma
  section.

- [ ] **Step 1: Write the failing e2e**

Add to `tests/e2e/legal-pages.spec.ts` a test that signs in as a platform admin,
opens the console screen, and finds the protocol submitted by the earlier
journey. Model the sign-in on `tests/e2e/audit.spec.ts`, which reaches the
console through the sidebar; Block 20b made every section a disclosure, so the
Platform section must be opened with `openNavSection(page, 'Platform')` from
`tests/e2e/nav.ts` before its links can be clicked.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/legal-pages.spec.ts -g "console"
```

Expected: FAIL — the nav item and the route do not exist.

- [ ] **Step 3: Write the screen**

Create `src/app/(admin)/admin/data-deletion-requests/page.tsx`, modelled on
`src/app/(admin)/admin/contact-requests/page.tsx` — read it first; it is 54
lines and this one should be about the same. The list shows the protocol, the
name, the telephone, the e-mail, the station, the status and the date.

- [ ] **Step 4: Add the nav item**

In `src/lib/auth/shell.ts`, add it to the `platform` section, after Contact
requests. Choose an icon that no adjacent row in that section already uses — the
house rule, recorded in `ICONS` and in four comments in that file, is that two
adjacent rows of one section must never share a glyph. State in your report which
you chose and which rows you compared it against.

Add the label to all three catalogues under `nav`.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
npx playwright test tests/e2e/legal-pages.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/admin/data-deletion-requests" src/lib/auth/shell.ts messages/ tests/e2e/legal-pages.spec.ts
git commit -F- <<'EOF'
feat: the console screen where a deletion request is worked

A request with a statutory clock on it needs somewhere an operator sees it,
records that identity was verified, and marks what was erased. Without a screen
the only trace is an e-mail, which is not a queue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 7: The gates, the documentation, and the push

- [ ] **Step 1: Record the pages where this project documents itself**

```bash
grep -rln "contato\|PUBLIC_PATHS\|public page" docs/*.md | head
```

`docs/ARCHITECTURE.md` and `docs/DEPLOYMENT.md` are living references. If either
describes the public surface, add the three addresses. Historical block reports
are **not** updated — they describe what was true when written. If nothing needs
changing, say so rather than inventing an edit.

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

`db:test` before the e2e and isolation suites, never after. Run the long suites
in the FOREGROUND with a generous timeout, capturing output to a file:
evidence lost to terminal truncation has cost this project twice.

Report the actual output of any failure rather than re-running until it passes.

- [ ] **Step 3: Commit any documentation change, then push**

```bash
git push
```

This adds to PR #65, open from this branch. Do not open a second one.

- [ ] **Step 4: Report**

State: a one-line result for each of the eight gates; **that migration `0188`
must reach the hosted database with the deploy**, alongside `0186` and `0187`
which are already there; which documentation changed; and the three addresses,
so the owner can hand them to Meta.
