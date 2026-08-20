import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';

/**
 * Block 30c's proof. Two things share this journey because they share a form:
 * the register dialog's discard confirmation (Task 5, item 13) and the rules
 * gate 0259 put inside `update_promotion` (Task 2) both live on the same
 * Promotion/WhatsApp tabs Task 4 gave two new fields to (Task 1's
 * `authorization_certificate` and `show_id`).
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: Playwright DISMISSES an unhandled
 * `window.confirm()` — which returns `false`, the exact same answer as
 * "keep editing". A journey that merely clicks Cancel and finds the dialog
 * still open would pass identically whether `requestClose`'s confirm() call is
 * there or deleted outright. Every dialog below is caught with an explicit
 * `page.once('dialog', …)`, its MESSAGE is asserted, and both answers are
 * driven — dismiss and accept — so the assertion dies if the confirm does.
 *
 * THE SECOND TRAP: the rules `<textarea>` carries `required={conversational}`
 * as a COURTESY (whatsapp-fields.tsx's own comment on it) — the boundary is
 * 0259's gate inside the database. A textarea truly left at length-zero is
 * caught by the BROWSER's own constraint validation before the click ever
 * reaches the server action, which would prove nothing about the database
 * gate at all. So this journey fills the field with a single space: HTML5's
 * `required` only tests for an empty string, but the server does
 * `nullif(btrim(coalesce(p_rules, '')), '')`, which treats whitespace exactly
 * as blank. That mismatch is the "client that skips or works around this
 * attribute" 0259's own migration comment names — reached here by ordinary
 * typed input, not by disabling anything.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-rules-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-rules-admin-${stamp}-pw`;
const ownerEmail = `e2e-rules-owner-${stamp}@example.test`;
const ownerPassword = `Owner-${stamp}-chosen`;
const orgName = `Rules Org ${stamp}`;
const stationName = `Rules Station ${stamp}`;
const showName = `Rules Programme ${stamp}`;
const promotionName = `Rules Promo ${stamp}`;
const certificate = `SECAP-${stamp}`;
const rulesText = `Rules for ${promotionName}: one entry per listener, 18+, no purchase necessary.`;

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

/** `YYYY-MM-DDTHH:mm`, what `<input type="datetime-local">` wants — the same
 * shape acceptance.spec.ts's own `localWallClock` builds, duplicated here
 * rather than imported: neither file exports it for the other to share, and a
 * six-line date formatter is cheaper to repeat than to promote to a module for
 * two callers. */
function localWallClock(offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

test('registering asks before discarding a draft, the rules gate refuses a blank-rules door by name, and the certificate and Programme survive a reload', async ({
  page,
  browser,
}) => {
  // --- seed a customer, an owner, and a Programme to point the promotion at -
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const provisionalPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail,
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

  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  if (!station) throw new Error(`no company row for ${stationName}`);

  // The Programme is fixture data for step 4's combobox, not the subject of
  // this journey — the same reasoning promotions-flow.spec.ts gives for
  // seeding its own promotions through create_promotion rather than the
  // register dialog. Seeded through the owner's OWN authenticated session
  // (not service_role: `shows` grants it no INSERT at all, and save_show is
  // SECURITY DEFINER re-checking auth.uid() regardless), so has_permission's
  // owner branch (0121) admits it without a role needing music.manage. One
  // band is the minimum save_show accepts (0175); its hours are never read by
  // this journey.
  const asOwner = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: ownerSignInError } = await asOwner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(ownerSignInError).toBeNull();

  const { data: showId, error: showError } = await asOwner.rpc('save_show', {
    p_company_id: station.id,
    p_name: showName,
    p_kind: 'MUSICAL',
    p_age_rating: '16',
    p_starts_on: '2026-01-01',
    p_bands: [{ days: [1], starts: '10:00', ends: '12:00' }],
  });
  expect(showError).toBeNull();
  if (typeof showId !== 'string') throw new Error('save_show returned no id');

  await ownerPage.goto(`/promotions?companyId=${station.id}`);

  // --- step 1: the register dialog's discard confirmation ------------------
  await test.step('the register dialog asks before discarding a draft, and only discards on accept', async () => {
    await ownerPage.getByTestId('promotion-create').click();
    const registerDialog = ownerPage.getByRole('dialog', { name: 'Register a promotion' });
    await expect(registerDialog).toBeVisible();

    const draftName = `${promotionName} (draft)`;
    await ownerPage.getByTestId('promotion-name').fill(draftName);

    // Dismiss: confirm() returns false, the "keep editing" answer — the SAME
    // answer Playwright gives an unhandled dialog, which is exactly why the
    // message itself is what is asserted here rather than the mere fact that
    // something was clicked.
    const dismissedMessages: string[] = [];
    ownerPage.once('dialog', async (dialog) => {
      dismissedMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await registerDialog.getByRole('button', { name: 'Cancel' }).click();
    expect(dismissedMessages).toEqual(['Discard the changes you have not saved?']);
    await expect(registerDialog).toBeVisible();
    await expect(ownerPage.getByTestId('promotion-name')).toHaveValue(draftName);

    // Accept: the same confirm(), answered the other way, actually discards —
    // proving the dialog staying open above was the confirmation working and
    // not the dialog being unable to close at all.
    const acceptedMessages: string[] = [];
    ownerPage.once('dialog', async (dialog) => {
      acceptedMessages.push(dialog.message());
      await dialog.accept();
    });
    await registerDialog.getByRole('button', { name: 'Cancel' }).click();
    expect(acceptedMessages).toEqual(['Discard the changes you have not saved?']);
    await expect(registerDialog).toBeHidden();
  });

  // --- step 2: register properly, then trip the gate on the record ---------
  await test.step('a promotion is registered properly, and turning on web entry with blank rules is refused by name', async () => {
    await ownerPage.getByTestId('promotion-create').click();
    // A fresh mount — the dialog's content unmounts on close (dialog.tsx),
    // so the draft name from step 1 is not here to accidentally reuse.
    await ownerPage.getByTestId('promotion-name').fill(promotionName);
    await ownerPage.getByTestId('promotion-starts').fill(localWallClock(-1));
    await ownerPage.getByTestId('promotion-ends').fill(localWallClock(30));
    await ownerPage.getByTestId('promotion-create-submit').click();

    const promotionRow = ownerPage.locator('[data-testid="promotion-row"]', {
      hasText: promotionName,
    });
    await expect(promotionRow).toBeVisible({ timeout: 15_000 });

    // Registering opens the new promotion's own record automatically
    // (PromotionsGrid's onCreated calls open() with no tab, which defaults to
    // PROMOTION_TABS[0] — 'data'), so the record is already open on the right
    // tab here — no close-and-reopen detour needed before step 4's, which is
    // the one this journey needs to prove a reopen at all. See step 4's own
    // comment on `waitForLoadState('networkidle')` for what closing costs.
    await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 15_000 },
    );

    await ownerPage.getByTestId('promotion-tab-whatsapp').click();
    await ownerPage.getByTestId('promotion-web-enabled').check();

    // A single space, not nothing — see this file's header comment. HTML5's
    // `required` accepts it; 0259's `btrim` does not.
    await ownerPage.getByTestId('promotion-rules').fill(' ');

    await ownerPage.getByTestId('promotion-save').click();

    // THE assertion this whole step exists for: the MESSAGE, not merely that
    // the save failed. A refusal for the wrong reason — a stale hashtag
    // collision, the freeze, a missing date — would pass a bare failure
    // check; this is the exact sentence 0259 raises and no other path in
    // update_promotion can produce.
    await expect(ownerPage.getByTestId('promotion-save-error')).toHaveText(
      'a promotion that takes part by WhatsApp or on the website needs its rules',
    );
    await expect(ownerPage.getByTestId('promotion-saved')).toHaveCount(0);
  });

  // --- step 3: the same door, filled in, goes through -----------------------
  await test.step('filling the rules lets the same save through', async () => {
    await ownerPage.getByTestId('promotion-rules').fill(rulesText);
    await ownerPage.getByTestId('promotion-save').click();
    await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible();
    await expect(ownerPage.getByTestId('promotion-save-error')).toHaveCount(0);
  });

  // --- step 4: the certificate and the Programme survive a reload ----------
  await test.step('the certificate and the Programme read back after a reload', async () => {
    await ownerPage.getByTestId('promotion-tab-data').click();
    await ownerPage.getByTestId('promotion-certificate').fill(certificate);
    await ownerPage.getByTestId('promotion-show').selectOption({ label: showName });
    await ownerPage.getByTestId('promotion-save').click();
    await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible();

    // Reloaded rather than trusted from the form still on screen: an
    // uncontrolled input's `defaultValue` is set once at mount and does not
    // pick up a later prop change, so the dialog's own post-save `refresh()`
    // would leave these fields showing exactly what was just typed whether or
    // not the write actually reached the database. Only a fresh mount forces
    // the values shown to come from the database rather than from what the
    // operator just typed.
    //
    // A RELOAD, NOT A CLOSE-AND-REOPEN. promotions/page.tsx:186 seeds
    // `initialRecord` from the URL's `record=`/`tab=` through
    // parseRecordParam, so with those still in the address a full
    // page.reload() re-renders the whole page from the server and mounts the
    // dialog from a cold read — proving strictly more than a reopen would,
    // since the WHOLE page re-renders rather than just the dialog. Nothing
    // calls history.back(), no popstate fires, and there is no background RSC
    // fetch in flight for this read to lose a dispatch inside — the window
    // close()'s own doc comment (use-record-dialog.ts) records for the
    // close-and-reopen path an earlier draft of this step took, and where it
    // intermittently hung (one run in three, with a networkidle wait already
    // in place — narrowing that window turned out not to be enough, so this
    // step stopped racing the hook rather than racing it more slowly). See
    // that comment for the mechanism and the evidence; this stays the pointer
    // rather than a second account of it.
    await expect(ownerPage).toHaveURL(/record=/);
    await ownerPage.reload();

    await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 15_000 },
    );

    await expect(ownerPage.getByTestId('promotion-certificate')).toHaveValue(certificate);
    await expect(ownerPage.getByTestId('promotion-show')).toHaveValue(showId);
  });

  await ownerContext.close();
});
