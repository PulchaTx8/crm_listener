import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 24, item 6: the View window on /participations.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The isolation suite proves
 * `getParticipationAnswers` returns the right rows to the right caller; pgTAP
 * proves the guidelines column and its door. Only this proves that an operator
 * standing on the list can open one entry and READ what the person answered —
 * the quiz option with its verdict, the written answer, and the internal
 * guidance above it that the listener never saw.
 *
 * The last of those is the point of item 5 as well as item 6: moderation
 * guidelines exist for whoever is reading three hundred written answers, and
 * this is the screen where that reading happens.
 *
 * The world is seeded through the real RPCs on the owner's own session rather
 * than by service_role inserts, the long way round participations-flow.spec.ts
 * already goes: Block 1a leaves the tenant tables read-only for service_role on
 * purpose, so there is no shortcut — and going the long way means the seeding
 * path is the production path.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
// provision_organization is gated on is_platform_admin(), which reads
// auth.uid() — service_role has no session and is refused. So the provisioning
// runs on a signed-in platform admin's own client, exactly as an operator would,
// which is the same shape participations-flow.spec.ts uses.
const platformAdminEmail = `e2e-partrec-admin-${stamp}@example.test`;
const platformAdminPassword = `Partrec-admin-${stamp}-pw`;
const ownerEmail = `e2e-partrec-owner-${stamp}@example.test`;
const ownerPassword = `Partrec-owner-${stamp}-pw`;
const orgName = `Partrec Org ${stamp}`;
const stationName = `Partrec Station ${stamp}`;
const promotionName = `Partrec Promo ${stamp}`;
const listenerName = `Marina Respondente ${stamp}`;
// The last four of these are what the window must show, and the rest is what it
// must not: the grid beside it renders the whole number, and this window does
// not.
const listenerPhone = `1195${String(stamp).slice(-7)}`;
const writtenAnswer = 'Tocou no rádio no dia em que conheci minha esposa.';
const guidelines = 'Prefira uma memória a uma resenha. Ignore a ortografia.';

const createdUserIds: string[] = [];
let stationId = '';

function anonClient(): SupabaseClient {
  return createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);

  const platformAdmin = await admin.auth.admin.createUser({
    email: platformAdminEmail,
    password: platformAdminPassword,
    email_confirm: true,
  });
  if (platformAdmin.error || !platformAdmin.data.user) {
    throw new Error(`could not create the platform admin: ${platformAdmin.error?.message}`);
  }
  createdUserIds.push(platformAdmin.data.user.id);
  await admin
    .from('profiles')
    .insert({ id: platformAdmin.data.user.id, email: platformAdminEmail });
  await admin.from('platform_admins').insert({ user_id: platformAdmin.data.user.id });

  const created = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`could not create the owner: ${created.error?.message}`);
  }
  createdUserIds.push(created.data.user.id);
  await admin.from('profiles').insert({ id: created.data.user.id, email: ownerEmail });

  const adminClient = anonClient();
  const adminSignIn = await adminClient.auth.signInWithPassword({
    email: platformAdminEmail,
    password: platformAdminPassword,
  });
  if (adminSignIn.error) {
    throw new Error(`could not sign the platform admin in: ${adminSignIn.error.message}`);
  }

  const { company_id } = await provisionCustomer(adminClient, {
    userId: created.data.user.id,
    organizationName: orgName,
    companyName: stationName,
  });
  stationId = company_id;

  const owner = anonClient();
  const signedIn = await owner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (signedIn.error) throw new Error(`could not sign in: ${signedIn.error.message}`);

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: stationId,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
  const promotionId = promotion.data as string;

  // A quiz with a right answer, so the window has a verdict to render, and the
  // listener picks the WRONG one — a right answer would pass just as well
  // against a screen that renders "right" unconditionally.
  const quiz = await owner.rpc('save_promotion_question', {
    p_promotion_id: promotionId,
    p_kind: 'QUIZ',
    p_prompt: 'Quem ganha a Copa?',
    p_menu_title: 'Escolha',
    p_button_label: 'Opções',
    p_options: [
      { label: 'Brasil', is_correct: true },
      { label: 'Argentina', is_correct: false },
    ],
  });
  if (quiz.error) throw new Error(`save_promotion_question failed: ${quiz.error.message}`);

  const essay = await owner.rpc('save_promotion_question', {
    p_promotion_id: promotionId,
    p_kind: 'ESSAY',
    p_prompt: 'Por que essa música?',
    p_options: [],
  });
  if (essay.error) throw new Error(`save_promotion_question (essay) failed: ${essay.error.message}`);

  const guidance = await owner.rpc('set_question_moderation_guidelines', {
    p_question_id: essay.data as string,
    p_guidelines: guidelines,
  });
  if (guidance.error) {
    throw new Error(`set_question_moderation_guidelines failed: ${guidance.error.message}`);
  }

  const member = await owner.rpc('create_member', {
    p_company_id: stationId,
    p_full_name: listenerName,
    p_phone: listenerPhone,
  });
  if (member.error) throw new Error(`create_member failed: ${member.error.message}`);

  const { data: options } = await owner
    .from('promotion_question_options')
    .select('id, label')
    .eq('question_id', quiz.data as string);
  const argentina = options?.find((o) => o.label === 'Argentina')?.id;
  if (!argentina) throw new Error('the quiz option was not seeded');

  const entry = await owner.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: member.data as string,
    p_source: 'MANUAL',
    p_participated_at: new Date().toISOString(),
    p_answers: [
      { question_id: quiz.data, option_id: argentina },
      { question_id: essay.data, answer_text: writtenAnswer },
    ],
  });
  if (entry.error) throw new Error(`record_participation failed: ${entry.error.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('an operator opens one entry and reads what the listener answered', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // provision_organization marks the owner's password provisional, so the
  // middleware holds every page request until it is changed. The seeding above
  // was not affected — that is RPCs on a signed-in client, and the gate is
  // middleware over page requests — but the browser is, so the first thing an
  // owner does here is what an owner really does.
  await expect(page).toHaveURL(/\/change-password$/);
  const chosen = `Partrec-owner-${stamp}-chosen`;
  await page.getByPlaceholder('New password').fill(chosen);
  await page.getByPlaceholder('Repeat the password').fill(chosen);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto(`/participations?companyId=${stationId}`);
  await expect(page.getByTestId('participation-row')).toHaveCount(1);

  await page.getByTestId('participation-view').click();

  // --- who ------------------------------------------------------------------
  await expect(page.getByTestId('participation-listener')).toHaveText(listenerName);

  // FOUR DIGITS AND NO MORE. Asserted as an exact string rather than with
  // `toContainText`: containing the last four is also true of the whole number,
  // which is precisely the thing this window is not supposed to show.
  await expect(page.getByTestId('participation-phone')).toHaveText(
    `•••• ${listenerPhone.slice(-4)}`,
  );
  await expect(page.getByTestId('participation-promotion')).toHaveText(promotionName);

  // --- what they answered ---------------------------------------------------
  const answers = page.getByTestId('participation-answer');
  await expect(answers).toHaveCount(2, { timeout: 30_000 });

  // The quiz, in the position it was asked, with the verdict DERIVED from the
  // option they chose — 0052 stores no correctness flag at all.
  await expect(answers.nth(0)).toContainText('Quem ganha a Copa?');
  await expect(answers.nth(0).getByTestId('participation-answer-option')).toContainText(
    'Argentina',
  );
  await expect(answers.nth(0).getByTestId('participation-answer-verdict')).toHaveText(
    'wrong answer',
  );

  // The written answer, and above it the guidance the listener never saw.
  await expect(answers.nth(1)).toContainText('Por que essa música?');
  await expect(answers.nth(1).getByTestId('participation-answer-text')).toHaveText(writtenAnswer);
  await expect(answers.nth(1).getByTestId('participation-answer-guidelines')).toContainText(
    guidelines,
  );

  // A quiz question carries no guidance, and the window must not borrow the
  // essay's — the shape constraint says so in SQL and this says so on screen.
  await expect(
    answers.nth(0).getByTestId('participation-answer-guidelines'),
  ).toHaveCount(0);

  // --- and it closes --------------------------------------------------------
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('participation-listener')).toHaveCount(0);
});
