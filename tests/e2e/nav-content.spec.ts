import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { openNavSection } from './nav';

/**
 * Block 20b, Task 1. The sidebar's CONTENTS and ORDER — not merely that a
 * link to each screen exists somewhere. src/lib/auth/shell.ts builds one tree
 * for both the member area and the platform console (its own header comment
 * says so), so this is the one file where a regression in either would show.
 *
 * A PLATFORM ADMIN, not an owner, and no Organization or Station is
 * provisioned at all. The eleventh section, 'platform', is admin-only
 * (shell.ts's own `if (isAdmin)` push at the bottom) — the reason this spec
 * needs a platform admin rather than an ordinary member. Every OTHER section
 * renders regardless of Organization membership: each one's own comment in
 * shell.ts records the courtesy (a permission gate lives in the database, not
 * in the nav), so a bare platform admin sees all eleven without provision.ts
 * ever being asked to build an owner and a Station nobody here reads from.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-nav-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-nav-admin-${stamp}-pw`;
const createdUserIds: string[] = [];

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: platformAdminEmail,
    password: platformAdminPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create admin: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await admin.from('profiles').insert({ id: data.user.id, email: platformAdminEmail });
  await admin.from('platform_admins').insert({ user_id: data.user.id });
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('the sidebar lists what the product does, in the order somebody chose', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Platform admin')).toBeVisible();

  // Block 20b, D1/D2/D3. The sidebar's CONTENTS and ORDER, asserted by section
  // rather than by counting links: a link exists somewhere is not the claim --
  // the claim is that Requests is filed under Audience and no longer under the
  // catalogue, which is the whole of item 3.
  //
  // English, because playwright.config.ts pins locale: 'en-US' for the suite.
  //
  // Block 20b, Task 3. Neither section is the one holding /app (Overview's
  // own), so both are collapsed by default and have to be opened before their
  // links can be asserted visible -- the same reason eighteen e2e call sites
  // call openNavSection before a sidebar click.
  await openNavSection(page, 'Audience');
  const audience = page.locator('[data-nav-section="audience"]');
  await expect(audience.getByRole('link', { name: 'Requests' })).toBeVisible();

  // Block 26. The owner's list of 2026-08-16 moved three things, and each one is
  // asserted where a regression would put it back.
  //
  // Participations LEFT Audience for Promotions. Asserting its absence here as
  // well as its presence there is the point: a move that only added would leave
  // the link rendered twice, in two sections, which is precisely the failure
  // shell.ts warns about for icons and labels.
  await expect(audience.getByRole('link', { name: 'Participations' })).toHaveCount(0);

  // Block 27. Programmes LEFT Audience for Catalog on the owner's ruling,
  // reversing where Block 18 filed it -- so this section is down to the two
  // screens that are about people. Read off the rendered order rather than
  // asserted one absence at a time, for the reason the Block 26 comment above
  // gives: a move that only adds leaves the link rendered twice.
  const audienceLinks = await audience.getByRole('link').allInnerTexts();
  expect(audienceLinks).toEqual(['Members', 'Requests']);

  await openNavSection(page, 'Promotions');
  const promotions = page.locator('[data-nav-section="promotions"]');
  // Participations sits BETWEEN Promotions and Pickups — the position is the
  // owner's instruction, not merely the section.
  const promotionLinks = await promotions.getByRole('link').allInnerTexts();
  expect(promotionLinks).toEqual(['Promotions', 'Participations', 'Pickups']);

  await openNavSection(page, 'Inventory');
  const inventory = page.locator('[data-nav-section="inventory"]');
  // Categories directly below Stock, which is where the owner put it. Block 27
  // then swapped Vendors and Movements, so the section reads as three reference
  // lists and then the ledger that consumes them.
  const inventoryLinks = await inventory.getByRole('link').allInnerTexts();
  expect(inventoryLinks).toEqual(['Stock', 'Categories', 'Vendors', 'Movements']);
  await expect(inventory.getByRole('link', { name: 'Categories' })).toHaveAttribute(
    'href',
    '/inventory/categories',
  );

  await openNavSection(page, 'Catalog');
  const catalogue = page.locator('[data-nav-section="catalog"]');
  await expect(catalogue.getByRole('link', { name: 'Requests' })).toHaveCount(0);
  // Block 27. The owner's order for the whole section, asserted as a list for the
  // same reason Audience's is: every one of these was already visible before the
  // reorder, so "it is here" proves nothing about where it is.
  const catalogueLinks = await catalogue.getByRole('link').allInnerTexts();
  expect(catalogueLinks).toEqual([
    'Songs',
    'Artists',
    'Albums',
    'Categories',
    'Genres',
    'Record labels',
    'Programmes',
    'Maintenance',
  ]);
  await expect(catalogue.getByRole('link', { name: 'Categories' })).toHaveAttribute(
    'href',
    '/catalog/categories',
  );
  // The item this replaces is gone: a section named Catalog holding an item
  // named Catalog is the "one link rendered twice" shell.ts warns about in
  // three separate comments. 'Catalog', not 'Catalogue' -- en.json's nav.catalog
  // spells it without the '-ue', and the British spelling appears nowhere in
  // this codebase, so asserting the absence of a string the product never used
  // would prove nothing about the regression this test exists to catch.
  await expect(catalogue.getByRole('link', { name: 'Catalog', exact: true })).toHaveCount(0);

  // D3. The two administrative sections sit AFTER Organization, at the foot of
  // the list -- which is the opposite of what the owner's item 8 literally said
  // and what they actually meant (spec §2 D3).
  //
  // Block 26 moved Inventory down to sit between Promotions and Catalog, so the
  // four operational sections now read in the order the work happens: who is
  // listening, what is being promised them, what there is to hand over, and what
  // is on the air.
  const keys = await page
    .locator('[data-nav-section]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-nav-section')));
  expect(keys).toEqual([
    'overview',
    'dashboards',
    'audience',
    'promotions',
    'inventory',
    'catalog',
    'templates',
    'organization',
    'reports',
    'administration',
    'platform',
  ]);
});

test('the sidebar remembers which sections a member opened', async ({ page }) => {
  // Sign in the same way the first test does.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // D4. Everything closed except the section holding the current page. The
  // links are in the DOM inside a `hidden` panel, so assert on VISIBILITY --
  // toHaveCount would pass for a section that is merely collapsed.
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeHidden();
  // toBeHidden() ALSO PASSES FOR AN ELEMENT THAT DOES NOT EXIST -- so on its
  // own the assertion above proves nothing about the reason the panel is
  // `hidden` rather than unmounted (aria-controls must point at something
  // that exists). This is the one line in the suite that actually checks the
  // panel stayed in the DOM.
  await expect(page.locator('#nav-section-catalog')).toHaveCount(1);

  // The section holding the landing page is open without anybody opening it.
  // The landing page IS /app -- Overview's own item ('My stations', shell.ts)
  // -- not Dashboards: activeSectionKey (disclosure.ts) matches a pathname
  // against ITEM hrefs, and no Dashboards item's href is /app, so Dashboards
  // would stay collapsed here same as Catalog above.
  await expect(
    page.locator('[data-nav-section="overview"]').getByRole('link', { name: 'My stations' }),
  ).toBeVisible();

  // 'Catalog', not 'Catalogue' -- the section's accessible name, same rule
  // nav-content.spec.ts's own first test already states for this exact word.
  // exact: true -- without it this is a case-insensitive SUBSTRING match, and
  // it would have kept passing today only because no other button's
  // accessible name happens to contain "Catalog" (nav.ts's own helper already
  // gets this right).
  await page.getByRole('button', { name: 'Catalog', exact: true }).click();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeVisible();

  // Whole-branch review. A SECOND section open at once, because that is the
  // case that actually exercises the cookie's comma. `serializeExpanded`
  // joins keys with ',', and the client writes the value through
  // `encodeURIComponent`, which percent-escapes that very comma -- it
  // round-trips today only because Next's cookie parser decodes the value on
  // read, and nothing pinned that dependency before this. The failure mode is
  // silent: a member with two sections open would lose both on reload, not
  // get an error.
  await openNavSection(page, 'Audience');

  // THE STEP THAT PROVES THE COOKIE. Everything above passes with pure client
  // state and no persistence at all; only a reload can tell the two apart.
  await page.reload();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-nav-section="audience"]').getByRole('link', { name: 'Members' }),
  ).toBeVisible();

  // And closing it is remembered too -- a one-way toggle would pass every
  // assertion above.
  await page.getByRole('button', { name: 'Catalog', exact: true }).click();
  await page.reload();
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Songs' }),
  ).toBeHidden();
});

test('the active section can be collapsed by hand, and it reopens on the next navigation', async ({
  page,
}) => {
  // Sign in the same way the first test does.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Reach a screen OUTSIDE Overview, so the section under test is one that
  // holds more than the single item /app already shows -- collapsing
  // Overview would prove nothing about a heading whose own section is what
  // is on screen.
  await openNavSection(page, 'Audience');
  await page.getByRole('link', { name: 'Members', exact: true }).click();
  await expect(page).toHaveURL(/\/members$/);

  // Audience is now the ACTIVE section -- open because of WHERE the caller
  // is (disclosure.ts's own contract), not because of anything they chose.
  //
  // THE BUG THIS TEST GUARDS: `toggle` used to run unconditionally while
  // `isSectionOpen` keeps the ACTIVE section open no matter what `expanded`
  // says -- so clicking this very heading changed nothing on screen,
  // `aria-expanded` never moved, and the click still silently wrote the
  // OPPOSITE of its own intent into the cookie (Audience "expanded", which
  // opens it on every OTHER screen). A screen-reader user saw a disclosure
  // button whose state never changed on activation.
  //
  // Whole-branch review. THE COOKIE HALF OF THAT BUG NEEDS PROVING DIRECTLY,
  // not inferred from a render: Audience's own heading renders open
  // unconditionally while it is active, no matter what the cookie says, so an
  // aria-expanded check on THIS heading proves nothing about the cookie while
  // the caller stays here -- and checking it on a LATER page does not rescue
  // the idea either, because Audience was legitimately opened (and so
  // legitimately written to the cookie) by the `openNavSection` call above,
  // needed just to reach Members in the first place. That write stays in the
  // cookie for the rest of this test, so a check for its ABSENCE after
  // leaving the page would be red always, fix or no fix -- worse than the
  // wrong claim it would replace. Comparing the cookie's raw value to itself,
  // before and after the click, is not confused by any of that.
  const navCookieValue = async () =>
    (await page.context().cookies()).find((c) => c.name === 'pulchatx_nav_open')?.value ?? null;

  const heading = page.getByRole('button', { name: 'Audience', exact: true });
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  const cookieBeforeCollapse = await navCookieValue();
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.locator('[data-nav-section="audience"]').getByRole('link', { name: 'Members' }),
  ).toBeHidden();
  // THE ASSERTION THAT ACTUALLY PROVES IT, in place of the wrong claim this
  // replaces: unchanged, where the original bug would have flipped Audience
  // out of `expanded` and rewritten the value.
  expect(await navCookieValue()).toBe(cookieBeforeCollapse);

  // A reload of this SAME page reads the cookie fresh (getShellContext,
  // server-side) and rebuilds React state from scratch. This does NOT retest
  // the invariant above -- it reads 'true' whether or not the cookie was
  // touched, because Audience is still the ACTIVE section here, and an active
  // section reads open regardless of `expanded`. What it proves instead: the
  // hand collapse does not survive a hard reload of the very page it was set
  // on, which is a different half of §4.2 than the click-based round trip
  // below.
  await page.reload();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');

  // §4.2: "it re-opens on the next navigation" -- collapse it again, leave
  // the page THROUGH A CLICK (not page.goto), then come back THROUGH A CLICK.
  //
  // A goto() PROVES NOTHING HERE: it is a hard navigation that remounts the
  // whole React tree, so it passes even for a version of this component that
  // carries no override-clearing logic at all -- SidebarNav is mounted ONCE
  // by the shared (app) layout and survives a client-side transition between
  // sibling routes (standard App Router layout persistence), which is
  // exactly the case a goto() cannot exercise. Reaching Promotions and coming
  // back to Audience by clicking sidebar links is what actually asks the
  // component to answer this on its own, without a fresh mount to fall back on.
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');

  await openNavSection(page, 'Promotions');
  await page.getByRole('link', { name: 'Promotions', exact: true }).click();
  await expect(page).toHaveURL(/\/promotions$/);

  await openNavSection(page, 'Audience');
  await page.getByRole('link', { name: 'Members', exact: true }).click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
});

test('a catalogue route lights up its own sidebar item, and only its own', async ({ page }) => {
  // Sign in the same way the first test does.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Block 20c. The three items point at real routes now, and therefore
  // HIGHLIGHT -- which they could not do while their hrefs carried ?tab=,
  // because the active-link test compares a pathname and a pathname never has
  // a query string. This assertion is the one 20b could not make.
  await openNavSection(page, 'Catalog');
  await page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Genres' }).click();
  await expect(page).toHaveURL(/\/catalog\/genres$/);
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Genres' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Albums' }),
  ).not.toHaveAttribute('aria-current', 'page');
});
