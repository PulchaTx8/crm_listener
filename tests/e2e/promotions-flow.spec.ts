import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';

/**
 * Block 4a's proof that the promotions screen keeps the promise Block 3c made
 * for the whole site: opening a record, moving between its tabs, saving it and
 * closing it does NOT re-run the list query behind it.
 *
 * The counter below is the same one record-dialog.spec.ts uses, and it carries
 * the same warning, which is the entire reason the row-position assertion
 * exists further down:
 *
 * WHAT THIS CANNOT SEE — a revalidatePath() inside a server action does NOT
 * produce a request of its own. Next returns the freshly rendered tree inside
 * the action's own POST response, which this counter deliberately ignores, so
 * the exact regression this block most fears would slip straight past it. What
 * catches that one is the assertion made AT THE MOMENT OF THE SAVE that the
 * renamed row has not moved: the list is sorted by name, the save renames the
 * first row to something that sorts last, and a list rebuilt from the server
 * re-sorts. Verified by mutation; see docs/block-4a-report.md.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-promo-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-promo-admin-${stamp}-pw`;
const ownerEmail = `e2e-promo-owner-${stamp}@example.test`;
const ownerPassword = `Owner-${stamp}-chosen`;
const orgName = `Promo Org ${stamp}`;
const stationName = `Promo Station ${stamp}`;

// Three promotions, named so that sorting by name is a known order. The save
// renames the first to something that would sort last if the list were ever
// re-queried.
const promotionNames = [`Ana Promo ${stamp}`, `Bruno Promo ${stamp}`, `Carla Promo ${stamp}`];
const renamed = `Zoe Promo ${stamp}`;

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

// Serial, and not by preference: the second test signs in as the owner with
// the password the FIRST one sets at the change-password gate. Run in parallel
// they race, and the second fails at sign-in with ?error=1 — which reads like
// a broken login rather than like the ordering dependency it is.
test.describe.configure({ mode: 'serial' });

test('the promotion record opens over a list that is never re-queried', async ({
  page,
  browser,
}) => {
  // --- seed a customer and an owner ----------------------------------------
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

  // Seeded through create_promotion on the owner's own session rather than by
  // driving the registration dialog three times: this spec is about what
  // happens to a list once it is on screen.
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
  for (const name of promotionNames) {
    const { error } = await asOwner.rpc('create_promotion', {
      p_company_id: station.id,
      p_name: name,
      p_starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(error).toBeNull();
  }

  // --- the journey ----------------------------------------------------------
  const renders = countListRenders(ownerPage);

  // Sorted by name so that a re-queried list would visibly re-order.
  await ownerPage.goto(`/promotions?companyId=${station.id}&sort=name`);
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(3);

  // BLOCK 31a. A promotion with no Programme says so with a dash rather than
  // with an empty cell. A READ, deliberately: the Refresh button is exercised
  // at the very end of this journey, because pressing it is a list re-query and
  // the counter this test is built around forbids exactly that.
  await expect(ownerPage.getByTestId('promotion-programme').first()).toHaveText('—');
  await expect(ownerPage.locator('[data-testid="promotion-row"]').first()).toContainText(
    promotionNames[0]!,
  );

  // Everything from here on must not re-render the list.
  renders.length = 0;

  // exact, because the row also carries "Edit <name>" and "Actions for <name>"
  // buttons and an accessible-name match is a substring match by default.
  await ownerPage.getByRole('button', { name: promotionNames[0], exact: true }).click();
  await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(ownerPage).toHaveURL(/record=/);

  await ownerPage.getByTestId('promotion-tab-whatsapp').click();
  await expect(ownerPage.getByTestId('promotion-whatsapp-enabled')).toBeVisible();
  await ownerPage.getByTestId('promotion-tab-quiz').click();
  await expect(ownerPage.getByTestId('quiz-add')).toBeVisible();

  // Checkpoint: opening and walking the tabs, on their own, cost nothing.
  // Asserted here rather than only at the end so that a failure names which
  // half of the journey caused it.
  expect(renders, 'opening the record and switching tabs').toEqual([]);

  // Add a quiz question with two options — one call, question and options
  // together (0043).
  await ownerPage.getByTestId('quiz-add').click();
  await ownerPage.getByTestId('quiz-kind').selectOption('QUIZ');
  await ownerPage.getByTestId('quiz-prompt').fill('Which country wins in 2026?');
  // No menu title and no button label: Block 24 (D3) took both off this form.
  // They are still written — savePromotionQuestion supplies the defaults,
  // because 0041's check requires them on a QUIZ — and this journey saving at
  // all is part of what proves it, since a question missing either is refused
  // by the database rather than accepted with a hole.
  const optionLabels = ownerPage.getByTestId('quiz-option-label');
  await optionLabels.nth(0).fill('Brazil');
  await optionLabels.nth(1).fill('Argentina');
  await ownerPage.getByTestId('quiz-option-correct').first().check();
  await ownerPage.getByTestId('quiz-save').click();
  await expect(ownerPage.getByTestId('quiz-question')).toHaveCount(1);
  expect(renders, 'saving a quiz question').toEqual([]);

  // Rename on the Promotion tab and save.
  await ownerPage.getByTestId('promotion-tab-data').click();
  await ownerPage.getByTestId('promotion-name').fill(renamed);
  await ownerPage.getByTestId('promotion-save').click();
  await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible();

  // THE assertion, made here rather than at the end of the journey so that a
  // failure names its cause. The list is sorted by name and this row is now
  // "Zoe …"; a list rebuilt from the server re-sorts and this row moves. Put
  // revalidatePath('/promotions') back into updatePromotionAction and only
  // this line goes red.
  await expect(ownerPage.locator('[data-testid="promotion-row"]').first()).toContainText(renamed);
  expect(renders, 'saving the promotion').toEqual([]);

  // Close with ESC, reopen with Forward, close with the footer button.
  //
  // Forward rather than Back: useRecordDialog's close calls history.back(), so
  // the closed list is the entry BEFORE the record, not a new one after it.
  // Going back again would walk off this screen entirely — which is what it did
  // when this was first written, and it reads like a broken dialog rather than
  // like a misread of the history stack.
  await ownerPage.keyboard.press('Escape');
  await expect(ownerPage).not.toHaveURL(/record=/);
  expect(renders, 'closing with ESC').toEqual([]);

  await ownerPage.getByRole('button', { name: renamed, exact: true }).click();
  await expect(ownerPage).toHaveURL(/record=/);
  expect(renders, 'reopening by clicking the row').toEqual([]);

  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(ownerPage).not.toHaveURL(/record=/);

  /**
   * THE ONE EXCEPTION, pinned rather than hidden.
   *
   * Every step above costs zero list renders. This one — the SECOND close in
   * one page life — costs exactly one RSC fetch of the list URL. Both closes
   * run the same `close()` in useRecordDialog, which calls `history.back()`;
   * the first is free and the second is not.
   *
   * This is a finding in the shared Block 3c hook, not in this screen, and the
   * audience screen has it too: record-dialog.spec.ts never exercises two
   * `close()` calls in one page life — it closes once with ESC and once with
   * the browser's own Back, which does not go through `close()` at all. That
   * is why it has gone unseen since Block 3c shipped.
   *
   * Asserted as the exact observed value, with the URL shape checked, so that
   * it cannot quietly grow: a fix makes this line fail, which is the point.
   * See docs/block-4a-report.md.
   */
  expect(renders, 'the second close in one page life').toHaveLength(1);
  expect(renders[0]).toMatch(/\/promotions\?[^#]*_rsc=/);
  expect(renders[0]).not.toContain('record=');

  // The row kept its place through all of it — including the one render above.
  await expect(ownerPage.locator('[data-testid="promotion-row"]').first()).toContainText(renamed);
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(3);

  // BLOCK 31a. Refresh, AFTER the counter has had its say: pressing it is a
  // list re-query on purpose, which is the one thing every assertion above
  // exists to forbid. It keeps the address — and therefore the filters — because
  // `router.refresh()` re-runs the Server Components for the current route
  // rather than navigating anywhere.
  const addressBefore = ownerPage.url();
  await ownerPage.getByTestId('refresh').click();
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(3);
  expect(ownerPage.url()).toBe(addressBefore);

  await ownerContext.close();
});

test('a promotion is cancelled with a reason, and only then archived', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto('/promotions?sort=name');
  const target = page.locator('[data-testid="promotion-row"]', {
    hasText: promotionNames[1]!,
  });
  await expect(target).toHaveCount(1);

  // Archiving a promotion that is still accepting entries is refused, and the
  // refusal comes from the RPC rather than from the interface hiding the
  // option — the message is the one 0042 raises.
  await target.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Archive promotion…' }).click();
  await page.getByTestId('promotion-archive-confirm').click();
  await expect(page.getByTestId('promotion-archive-error')).toContainText(
    'still accepting entries',
  );
  await page.getByRole('button', { name: 'Keep it' }).click();

  // Cancel it, with the reason the RPC insists on.
  await target.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Cancel promotion…' }).click();
  await page.getByTestId('promotion-cancel-reason').fill('Sponsor withdrew');
  await page.getByTestId('promotion-cancel-confirm').click();

  // The record reopens showing the cancellation, and the row now reads
  // Cancelled — patched, not re-queried.
  await expect(page.getByTestId('promotion-dialog-situation')).toHaveText('Cancelled');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(target.getByTestId('promotion-situation')).toHaveText('Cancelled');

  // Now archiving is allowed, and the row leaves the list.
  await target.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Archive promotion…' }).click();
  await page.getByTestId('promotion-archive-confirm').click();
  await expect(
    page.locator('[data-testid="promotion-row"]', { hasText: promotionNames[1]! }),
  ).toHaveCount(0);

  // The owner, and only the owner, can still find it.
  // click, not check: this checkbox is controlled by the URL, so its state
  // changes only once the navigation it triggers has landed. `check()` asserts
  // the change synchronously and fails on a control that is working correctly.
  await page.getByTestId('promotion-archived-filter').click();
  await expect(page).toHaveURL(/archived=1/);
  await expect(
    page.locator('[data-testid="promotion-row"]', { hasText: promotionNames[1]! }),
  ).toHaveCount(1);

  await context.close();
});

/**
 * A record address arriving cold — pasted, bookmarked, or followed from a chat
 * message — rather than produced by the hook while the list is already on
 * screen.
 *
 * This is the ONE path on which parseRecordParam runs on the server, and no
 * spec covered it with a tab from Block 3c until this one: every other test
 * opens a record by clicking a row, which runs the same parse inside
 * useRecordDialog in the browser, where the tab tuple is the real array. On the
 * server the page used to import that tuple across the 'use client' boundary
 * and get back something that is not an array, so this address answered with an
 * error boundary rather than a record. The full account is in
 * src/lib/record-params.ts, beside the tuples that moved.
 *
 * `tab=quiz` deliberately: not the first tab, so a fallback that silently lands
 * on `data` fails here instead of passing by accident. A tab is what makes this
 * the loud case — an address carrying only `?record=` took a different branch
 * and failed quietly, which is how two specs walked past it for three blocks.
 */
test('a record address typed straight into the bar opens on the tab it names', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Read back rather than remembered from the seeding test: this promotion is
  // the one neither earlier test touches, and looking it up by name keeps this
  // test from depending on the order the seed loop happened to run in.
  const { data: promotion } = await admin
    .from('promotions')
    .select('id')
    .eq('name', promotionNames[2]!)
    .single();
  if (!promotion) throw new Error(`no promotion row for ${promotionNames[2]}`);

  await page.goto(`/promotions?record=${promotion.id}&tab=quiz`);

  // The list rendered at all — the assertion that catches a server render that
  // threw, because a thrown page shows the error boundary and no rows.
  await expect(page.getByTestId('promotion-row').first()).toBeVisible();

  // The record opened, on the tab the address named and not on the first one.
  await expect(page.getByTestId('promotion-tab-quiz')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('promotion-tab-data')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('quiz-add')).toBeVisible();

  // A tab nobody has ever heard of is hostile input, not an error page: the
  // record still opens, on the first tab. Same contract parseRecordParam's unit
  // test states for the same input — asserted again here because this is the
  // call site where the tuple it validates against comes from somewhere else.
  await page.goto(`/promotions?record=${promotion.id}&tab=nonsense`);
  await expect(page.getByTestId('promotion-tab-data')).toHaveAttribute('aria-selected', 'true');

  await context.close();
});
