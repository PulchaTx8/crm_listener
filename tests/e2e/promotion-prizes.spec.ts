import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';

/**
 * Block 4b's proof that the Prizes tab keeps the promise Block 3c made for the
 * whole site and Block 4a re-made for this screen: linking a prize to a
 * promotion, and returning it to stock, moves real units through the ledger
 * without the promotions list behind the dialog being re-queried once.
 *
 * The counter below is the same one record-dialog.spec.ts and
 * promotions-flow.spec.ts use, and it carries the same warning, which is the
 * entire reason the "the list never learned about it" assertions exist further
 * down:
 *
 * WHAT THIS CANNOT SEE — a revalidatePath() inside a server action does NOT
 * produce a request of its own. Next returns the freshly rendered tree inside
 * the action's own POST response, which this counter deliberately ignores, so
 * the exact regression this block most fears would slip straight past it. What
 * catches that one is the compensating assertion made AT THE MOMENT OF EACH
 * WRITE that the list is still showing exactly the one promotion it was showing
 * when it rendered — a SECOND promotion is registered out of band, after the
 * list is on screen, so a list rebuilt from the server would grow a row.
 *
 * That is deliberately NOT promotions-flow.spec.ts's shape, and the difference
 * matters: there, the save renames the first row to something that sorts last,
 * so a re-queried list re-sorts and the row moves. Neither write here touches
 * anything the list shows — not the name, the window, the situation, the
 * hashtag or the question count — so a re-render would come back byte-identical
 * and a row-position assertion would pass while the list had in fact been
 * re-queried. It would be an assertion that could not fail, which is worse than
 * no assertion. A row that only the server knows about is the compensation this
 * particular pair of writes admits of.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-prize-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-prize-admin-${stamp}-pw`;
const ownerEmail = `e2e-prize-owner-${stamp}@example.test`;
const ownerPassword = `Owner-${stamp}-chosen`;
const orgName = `Prize Org ${stamp}`;
const stationName = `Prize Station ${stamp}`;
const prizeName = `Prize Hoodie ${stamp}`;
const promotionName = `Ana Prize Promo ${stamp}`;
/**
 * Registered on the owner's own session AFTER the list is on screen and while
 * the record is open. Nothing in this test ever navigates to /promotions again,
 * so the only way this name can reach the screen is a re-render of the list —
 * which is exactly what must not happen.
 */
const unseenPromotionName = `Zoe Prize Promo ${stamp}`;

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

/**
 * Counts the requests that would re-render the promotions list: a document
 * navigation to /promotions, or an RSC payload fetch for it. Next marks the
 * latter with an `RSC` header and an `_rsc` query parameter.
 *
 * Server-action POSTs on the same path are expected and excluded by resource
 * type: the block forbids re-running the LIST, not talking to the server.
 */
function countListRenders(page: Page): string[] {
  const renders: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/promotions')) return;
    const isRsc = url.searchParams.has('_rsc') || request.headers()['rsc'] === '1';
    if (request.resourceType() === 'document' || isRsc) renders.push(request.url());
  });
  return renders;
}

/**
 * The index of the Available column on /inventory: Picture, Prize, Code,
 * Category, Added, In stock, Available.
 *
 * Six until Block 14 put the prize's photograph in the first column. That move
 * is exactly the one the comment on availableCell predicts, and
 * assertAvailableHeader is what caught it — the locator had slid onto In stock,
 * which holds the same figure throughout this journey, so the assertion at the
 * end would have gone on passing while measuring nothing.
 */
const AVAILABLE_COLUMN = 6;

/**
 * The Available cell of a prize's row on /inventory.
 *
 * Addressed by position rather than by a test id, because the inventory list
 * has none on that cell — checked before writing this, not assumed.
 *
 * Which makes the index the whole risk, and it is not a theoretical one: the
 * column immediately before Available is In stock, and at every point in this
 * journey the two hold the SAME NUMBER, because nothing here reserves, delivers
 * or writes off. Insert one column anywhere to the left and this locator slides
 * onto In stock — a figure that never moves — and the assertion at the end of
 * the test goes on passing while measuring nothing at all. assertAvailableHeader
 * below is what stops that: it reads the header at this same index and fails if
 * it is not the column this function claims to be reading.
 */
function availableCell(page: Page, name: string) {
  return page
    .locator('[data-testid="prize-row"]', { hasText: name })
    .locator('td')
    .nth(AVAILABLE_COLUMN);
}

async function assertAvailableHeader(page: Page) {
  await expect(
    page.locator('thead th').nth(AVAILABLE_COLUMN),
    'the column availableCell reads by index must still be Available',
  ).toHaveText('Available');
}

test('linking a prize moves stock without the list behind the dialog being re-queried', async ({
  page,
  browser,
}) => {
  // --- seed a customer and an owner ------------------------------------------
  // The same sequence promotions-flow.spec.ts performs in its first test, and
  // through the same real screens.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const provisionalPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail: ownerEmail,
  });

  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  if (!ownerProfile) throw new Error(`no profile row for ${ownerEmail}`);
  createdUserIds.push(ownerProfile.id);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/login');
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(provisionalPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);
  await ownerPage.getByPlaceholder('New password').fill(ownerPassword);
  await ownerPage.getByPlaceholder('Repeat the password').fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // The promotion is seeded through create_promotion on the owner's own session
  // rather than by driving the registration dialog, for the reason
  // promotions-flow.spec.ts gives for its own three: this spec is about what
  // happens to a list once it is on screen. The PRIZE is not seeded that way —
  // it goes in through the real inventory screens, because the stock it carries
  // is what the last assertion in this test reads back off those same screens.
  const asOwner = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: ownerSignInError } = await asOwner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(ownerSignInError).toBeNull();

  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  if (!station) throw new Error(`no company row for ${stationName}`);

  const DAY = 24 * 60 * 60 * 1000;
  const { error: promotionError } = await asOwner.rpc('create_promotion', {
    p_company_id: station.id,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  expect(promotionError).toBeNull();

  // --- the owner registers a prize and puts ten units in stock ---------------
  await ownerPage.goto('/inventory');
  await ownerPage.getByTestId('prize-create').click();
  const prizeForm = ownerPage.locator('[data-testid="prize-form"]');
  await prizeForm.getByLabel('Name').fill(prizeName);
  await prizeForm.getByRole('button', { name: 'Register prize' }).click();
  await expect(prizeForm.getByText('Prize registered.')).toBeVisible();
  await prizeForm.getByRole('button', { name: 'View prize' }).click();

  // Block 23 split the record's one old "Stock movements" tab into five —
  // an entry now lives on its own tab, Entradas.
  await ownerPage.getByRole('tab', { name: 'Entries' }).click();
  const entryForm = ownerPage.locator('[data-testid="stock-entry-form"]');
  await expect(entryForm).toBeVisible();
  await entryForm.getByLabel('Quantity').fill('10');
  await entryForm.getByRole('button', { name: 'Add stock' }).click();
  await expect(entryForm.getByText('Stock added.')).toBeVisible();

  const { data: prize } = await admin
    .from('prizes')
    .select('id')
    .eq('company_id', station.id)
    .eq('name', prizeName)
    .single();
  if (!prize) throw new Error(`no prize row for ${prizeName}`);

  // --- the journey -----------------------------------------------------------
  const renders = countListRenders(ownerPage);

  await ownerPage.goto('/promotions');
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByTestId('promotion-row').first()).toContainText(promotionName);

  // The navigation that put this list on screen is a render of it, and it is
  // the last one this journey is allowed. Cleared rather than tolerated in the
  // assertions below, so that the number checked is zero and not a magic
  // constant somebody would later "fix" by incrementing.
  renders.length = 0;

  // A button, not a link: the promotions grid opens a record with
  // `window.history.pushState` from a click handler, and a real anchor would be
  // a navigation, which is the one thing this screen is built not to do.
  // `exact`, because the row also carries "Edit <name>" and "Actions for
  // <name>" controls and an accessible-name match is a substring match by
  // default.
  await ownerPage.getByRole('button', { name: promotionName, exact: true }).click();
  await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await ownerPage.getByTestId('promotion-tab-prizes').click();
  await expect(ownerPage).toHaveURL(/tab=prizes/);
  await expect(ownerPage.getByTestId('prize-link-open')).toBeVisible();

  // Asserted, not merely asserted-about-in-a-comment: the tab renders from the
  // record that was already read when the dialog opened, so reaching it costs
  // nothing at all. Checked here rather than only at the end so that a failure
  // names which half of the journey caused it.
  expect(renders, 'opening the record and switching to the Prizes tab').toEqual([]);

  // The footer's Save submits the promotion's own form, which this tab shows
  // none of. All four tabs are checked, not just the new one: the condition
  // that hides it is a property of every tab, and the two that must still offer
  // it are the two the shared form spans.
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(0);
  await ownerPage.getByTestId('promotion-tab-quiz').click();
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(0);
  await ownerPage.getByTestId('promotion-tab-data').click();
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(1);
  await ownerPage.getByTestId('promotion-tab-whatsapp').click();
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(1);
  await ownerPage.getByTestId('promotion-tab-prizes').click();

  // The ammunition for every "the list never learned about it" assertion below.
  // Registered now, with the list already on screen and the record open: the
  // screen cannot know about it, and a list rebuilt from the server cannot miss
  // it.
  const { error: unseenError } = await asOwner.rpc('create_promotion', {
    p_company_id: station.id,
    p_name: unseenPromotionName,
    p_starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  expect(unseenError).toBeNull();
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);

  // --- link four of the ten units -------------------------------------------
  await ownerPage.getByTestId('prize-link-open').click();
  await ownerPage.getByTestId('prize-link-search').fill(prizeName);
  await ownerPage
    .getByTestId('prize-link-select')
    .selectOption({ label: `${prizeName} — 10 available` });
  await ownerPage.getByTestId('prize-link-quantity').fill('4');
  await ownerPage.getByTestId('prize-link-save').click();

  await expect(ownerPage.getByTestId('promotion-prize-row')).toHaveCount(1);
  await expect(ownerPage.getByTestId('promotion-prize-row')).toContainText(prizeName);
  await expect(ownerPage.getByTestId('promotion-prize-linked')).toHaveText('4');
  // Nothing is drawn until Block 6, so Resto is the whole of it — and Resto is
  // computed on screen from the two figures beside it, which is why it is
  // asserted rather than taken on trust from the column header.
  await expect(ownerPage.getByTestId('promotion-prize-drawn')).toHaveText('0');
  await expect(ownerPage.getByTestId('promotion-prize-left')).toHaveText('4');

  // The units really left `available`, read from the ledger's own projection
  // rather than from the tab that has just said so — and read HERE, while they
  // are still linked, so that the figure at the end of this test is a return to
  // ten rather than a number that never moved.
  const { data: whileLinked } = await admin
    .from('inventory_balances')
    .select('available,linked')
    .eq('company_id', station.id)
    .eq('prize_id', prize.id)
    .single();
  expect(whileLinked).toMatchObject({ available: 6, linked: 4 });

  // The whole point of the block's screen rule: the write and the re-read both
  // happened, and the list behind the dialog was rendered neither time.
  expect(renders, 'linking a prize').toEqual([]);
  // And the compensating assertion the counter above cannot make for itself. A
  // revalidatePath in linkPrizeAction returns a rebuilt list inside the
  // action's own response, and that list has two promotions in it.
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByText(unseenPromotionName)).toHaveCount(0);

  // --- return all four ------------------------------------------------------
  // Addressed by the prize's id rather than by a bare `prize-unlink`: the
  // controls used to share one test id across every row and worked only while
  // exactly one prize was linked. A second row would have made these strict-mode
  // violations.
  await ownerPage.getByTestId(`prize-unlink-quantity-${prize.id}`).fill('4');
  await ownerPage.getByTestId(`prize-unlink-${prize.id}`).click();

  // A link unwound to nothing is soft-deleted by the RPC (0049), so the row
  // leaves the tab rather than sitting there as a row of zeros.
  await expect(ownerPage.getByTestId('promotion-prize-row')).toHaveCount(0);

  expect(renders, 'returning a prize to stock').toEqual([]);
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByText(unseenPromotionName)).toHaveCount(0);

  // And the units are actually back — asserted against the inventory screen
  // rather than against the tab that just said so.
  await ownerPage.goto('/inventory');
  await assertAvailableHeader(ownerPage);
  await expect(availableCell(ownerPage, prizeName)).toHaveText('10');

  await ownerContext.close();
});
