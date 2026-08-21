import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';

/**
 * Block 14. The journey the operator actually makes, and the one guarantee this
 * block was asked for and cannot assert anywhere else:
 *
 *   UPLOADING A SECOND PICTURE LEAVES ONE OBJECT, NOT TWO.
 *
 * Nothing in the unit suite can see that — it is a property of the storage key
 * and of `upsert`, which only a real bucket has — and nothing in pgTAP can
 * either, because the object is written through the Storage API rather than
 * through SQL. It is measured here by listing the bucket.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-img-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-img-admin-${stamp}-pw`;
const ownerEmail = `e2e-img-owner-${stamp}@example.test`;
const ownerPassword = `Owner-img-${stamp}-chosen`;
const orgName = `Image Org ${stamp}`;
const stationName = `Image Station ${stamp}`;

const promotionName = `Pictured Promo ${stamp}`;
const prizeName = `Pictured Prize ${stamp}`;
// Block 30c (0259): create_promotion now refuses a WhatsApp-enabled
// promotion with blank rules. This spec is about the pictures, not the
// rules text, so a placeholder rather than anything asserted on — the same
// idiom whatsapp-entry.spec.ts and widget.spec.ts already use.
const PROMOTION_RULES = `Regras da promoção com fotos, edição ${stamp}.`;

/**
 * REAL PNG BYTES, not the header-shaped fixtures the unit suite builds.
 *
 * The upload control decodes what it is given — `createImageBitmap` for the
 * banner's measurement, a canvas for the thumb's reduction — so a file that
 * only looks like a PNG to a byte reader is refused here with "That picture
 * could not be read", which is the control working correctly and the test
 * failing for the wrong reason. These two are 1x1, differing in colour so the
 * second upload is genuinely a different file.
 */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const BLUE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function png(name: string, buffer: Buffer) {
  return { name, mimeType: 'image/png', buffer };
}

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

test('a promotion and a prize each carry one picture, replaced rather than accumulated', async ({
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

  const asOwner = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await asOwner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(signInError).toBeNull();

  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  if (!station) throw new Error(`no company row for ${stationName}`);

  // Seeded through the RPCs on the owner's own session rather than by driving
  // the two registration dialogs: this spec is about the pictures.
  const DAY = 24 * 60 * 60 * 1000;
  const { data: promotionId, error: promoError } = await asOwner.rpc('create_promotion', {
    p_company_id: station.id,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: `#IMG${stamp}`,
    p_rules: PROMOTION_RULES,
  });
  expect(promoError).toBeNull();

  const { data: prizeId, error: prizeError } = await asOwner.rpc('create_prize', {
    p_company_id: station.id,
    p_name: prizeName,
  });
  expect(prizeError).toBeNull();

  // --- the promotion's thumb ------------------------------------------------
  await ownerPage.goto(`/promotions?companyId=${station.id}`);
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);

  // Nothing uploaded yet, so the row shows the honest gap rather than a broken
  // picture. Asserted before the upload so that the assertion after it is about
  // the upload rather than about whatever was already on screen.
  await expect(ownerPage.getByTestId('image-thumb-empty')).toHaveCount(1);

  await ownerPage.getByRole('button', { name: promotionName, exact: true }).click();
  await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await ownerPage.getByTestId('thumb-input').setInputFiles(png('thumb.png', RED_PNG));
  await expect(ownerPage.getByTestId('thumb-preview')).toBeVisible();
  await ownerPage.getByTestId('promotion-save').click();
  await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible({ timeout: 15_000 });

  // The row is patched from the record's own re-read, so the picture reaches
  // the list without the list being re-queried — the rule Block 3c set.
  await expect(ownerPage.getByTestId('image-thumb')).toHaveCount(1);

  const { data: withThumb } = await admin
    .from('promotions')
    .select('thumb_url')
    .eq('id', promotionId as string)
    .single();
  expect(withThumb?.thumb_url).toContain(`promotion-thumbs/${station.id}/${promotionId}`);
  // The version stamp is what stops a stable key serving a replaced picture out
  // of the CDN.
  expect(withThumb?.thumb_url).toMatch(/\?v=\d+$/);

  // --- the banner, uploaded twice -------------------------------------------
  await ownerPage.getByTestId('promotion-tab-whatsapp').click();
  await ownerPage.getByTestId('art-input').setInputFiles(png('banner.png', RED_PNG));
  await ownerPage.getByTestId('promotion-save').click();
  await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible({ timeout: 15_000 });

  const { data: firstBanner } = await admin
    .from('promotions')
    .select('art_url, use_art')
    .eq('id', promotionId as string)
    .single();
  expect(firstBanner?.art_url).toContain(`promotion-banners/${station.id}/${promotionId}`);
  // use_art is set from the presence of the address, never independently: the
  // tick that used to do it is gone from the screen (0144).
  expect(firstBanner?.use_art).toBe(true);

  await ownerPage.getByTestId('art-input').setInputFiles(png('banner-2.png', BLUE_PNG));
  await ownerPage.getByTestId('promotion-save').click();
  await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible({ timeout: 15_000 });

  const { data: secondBanner } = await admin
    .from('promotions')
    .select('art_url')
    .eq('id', promotionId as string)
    .single();
  expect(secondBanner?.art_url).not.toBe(firstBanner?.art_url);

  // THE ASSERTION THIS SPEC EXISTS FOR. The key is derived from the promotion
  // and carries no file extension, so the second upload writes over the first.
  // Two objects here would mean the bucket accumulating a picture per save,
  // which is exactly what this block was asked to prevent.
  const { data: banners, error: listError } = await admin.storage
    .from('artwork')
    .list(`promotion-banners/${station.id}`);
  expect(listError).toBeNull();
  expect(banners?.filter((o) => o.name === promotionId)).toHaveLength(1);

  // --- removing it ----------------------------------------------------------
  await ownerPage.getByTestId('art-remove').click();
  await ownerPage.getByTestId('promotion-save').click();
  await expect(ownerPage.getByTestId('promotion-saved')).toBeVisible({ timeout: 15_000 });

  const { data: cleared } = await admin
    .from('promotions')
    .select('art_url, use_art')
    .eq('id', promotionId as string)
    .single();
  expect(cleared?.art_url).toBeNull();
  expect(cleared?.use_art).toBe(false);

  // The bytes outlive the column until the worker runs, which is why clearing
  // queues rather than deletes. A promise recorded and not kept is the one
  // failure 0087 exists to prevent.
  const { data: queued } = await admin
    .from('storage_erasure_queue')
    .select('bucket, path')
    .eq('bucket', 'artwork')
    .eq('path', `promotion-banners/${station.id}/${promotionId}`);
  expect(queued).toHaveLength(1);

  // exact, because the dialog also carries a "Close record" icon button and an
  // accessible-name match is a substring match by default.
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // --- the prize's photograph ----------------------------------------------
  await ownerPage.goto(`/inventory?companyId=${station.id}`);
  await expect(ownerPage.getByTestId('prize-row')).toHaveCount(1);
  await expect(ownerPage.getByTestId('image-thumb-empty')).toHaveCount(1);

  await ownerPage.getByRole('button', { name: prizeName, exact: true }).click();
  await expect(ownerPage.getByTestId('prize-data-form')).toBeVisible();

  await ownerPage.getByTestId('photo-input').setInputFiles(png('prize.png', BLUE_PNG));
  await expect(ownerPage.getByTestId('photo-preview')).toBeVisible();
  await ownerPage.getByTestId('prize-data-form').getByRole('button', { name: 'Save' }).click();

  // Waited for on SCREEN before the database is read. The grid patches its row
  // from the summary the action returns — which carries the address the upload
  // gave back rather than the one read before it — so this appearing is the
  // action having finished. Reading the row first is a race the action loses
  // roughly always, and it reads as "the photograph was never saved".
  await expect(ownerPage.getByTestId('image-thumb')).toHaveCount(1, { timeout: 15_000 });

  const { data: photographed } = await admin
    .from('prizes')
    .select('photo_url')
    .eq('id', prizeId as string)
    .single();
  expect(photographed?.photo_url).toContain(`prize-photos/${station.id}/${prizeId}`);

  await ownerContext.close();
});
