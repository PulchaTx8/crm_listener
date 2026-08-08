import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * Block 6c through the screen: the draw is a shuffle over a list somebody
 * filtered and looked at.
 *
 * One journey, because the claims only mean anything in sequence:
 *
 *   1. Participations is reached from the sidebar's AUDIENCE section, not from
 *      Promotions (D9's sibling ruling, spec §5);
 *   2. filtering to the listeners who answered the quiz correctly leaves fewer
 *      rows than the promotion has entries;
 *   3. the draw panel names the size of the hat BEFORE anything is drawn, which
 *      is what makes the set an operator approves a set rather than a
 *      description;
 *   4. a round awards a prize to somebody in that hat;
 *   5. and the second round cannot award them again — the row now says "Won
 *      here", and the hat has shrunk by exactly one. That is D4, and it is the
 *      rule 6a shipped one draw too narrow.
 *
 * Fixtures are seeded through the real RPCs on a signed-in client rather than
 * clicked through the registration screens, for the reason draw-flow.spec.ts
 * gives for its own: those screens are Blocks 2 and 4's to prove, and thirty
 * clicks of setup in front of this would make it fail for reasons that have
 * nothing to do with the filtered hat.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-hat-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-hat-admin-${stamp}-pw`;
const ownerEmail = `e2e-hat-owner-${stamp}@example.test`;
const ownerPassword = `Owner-hat-${stamp}-provisional`;
const ownerFinalPassword = `Owner-hat-${stamp}-chosen`;
const promotionName = `Hat Promo ${stamp}`;

/** Two answer correctly and two do not, so the filter has something to remove. */
const RIGHT_ANSWERERS = [`Rita Right ${stamp}`, `Rui Right ${stamp}`];
const WRONG_ANSWERERS = [`Wanda Wrong ${stamp}`, `Wilson Wrong ${stamp}`];

const createdUserIds: string[] = [];
let companyId = '';
let promotionId = '';

async function signIn(email: string, password: string) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in failed for ${email}: ${error.message}`);
  return client;
}

async function createUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await admin.from('profiles').insert({ id: data.user.id, email });
  return data.user.id;
}

test.beforeAll(async () => {
  const adminId = await createUser(platformAdminEmail, platformAdminPassword);
  await admin.from('platform_admins').insert({ user_id: adminId });
  const ownerId = await createUser(ownerEmail, ownerPassword);

  const adminClient = await signIn(platformAdminEmail, platformAdminPassword);
  const provisioned = await adminClient.rpc('provision_customer', {
    p_user_id: ownerId,
    p_organization_name: `Hat Org ${stamp}`,
    p_company_name: `Hat Station ${stamp}`,
    p_timezone: 'America/Sao_Paulo',
  });
  if (provisioned.error) throw new Error(`provision failed: ${provisioned.error.message}`);
  ({ company_id: companyId } = provisioned.data as { company_id: string });

  const owner = await signIn(ownerEmail, ownerPassword);

  const prize = await owner.rpc('create_prize', {
    p_company_id: companyId,
    p_name: `Hat Prize ${stamp}`,
  });
  if (prize.error) throw new Error(`create_prize failed: ${prize.error.message}`);

  // TWO units, because the journey draws twice: the second round is what proves
  // a winner cannot be drawn again, and it needs something left to win.
  await owner.rpc('record_stock_entry', {
    p_company_id: companyId,
    p_prize_id: prize.data as string,
    p_type: 'MANUAL_ENTRY',
    p_quantity: 2,
  });

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
  promotionId = promotion.data as string;

  await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prize.data as string,
    p_quantity: 2,
  });

  // A QUIZ, which is what makes "answered correctly" a question with two
  // answers. A poll would leave promotion_participation_correctness (0089)
  // answering true for everybody, and the filter would not even render.
  const question = await owner.rpc('save_promotion_question', {
    p_promotion_id: promotionId,
    p_kind: 'QUIZ',
    p_prompt: 'Which station is this?',
    // Both required for anything with options (promotion_questions_list_fields,
    // 0041): they are the two fields of a WhatsApp interactive list message, and
    // a QUIZ without them is refused by the check constraint.
    p_menu_title: 'Answer',
    p_button_label: 'Choose',
    p_options: [
      { label: 'The right one', is_correct: true },
      { label: 'The other one', is_correct: false },
    ],
  });
  if (question.error) throw new Error(`save_promotion_question failed: ${question.error.message}`);

  const options = await owner
    .from('promotion_question_options')
    .select('id,is_correct')
    .eq('question_id', question.data as string);
  if (options.error) throw new Error(`could not read the options: ${options.error.message}`);
  const rightOption = options.data.find((option) => option.is_correct)?.id;
  const wrongOption = options.data.find((option) => !option.is_correct)?.id;
  if (!rightOption || !wrongOption) throw new Error('the quiz did not come back with both options');

  const entrants: { name: string; optionId: string }[] = [
    ...RIGHT_ANSWERERS.map((name) => ({ name, optionId: rightOption })),
    ...WRONG_ANSWERERS.map((name) => ({ name, optionId: wrongOption })),
  ];

  for (const [index, entrant] of entrants.entries()) {
    const member = await owner.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: entrant.name,
    });
    if (member.error) throw new Error(`create_member failed: ${member.error.message}`);
    const recorded = await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: member.data as string,
      p_participated_at: new Date(Date.now() - (index + 1) * 60 * 60 * 1000).toISOString(),
      p_source: 'MANUAL',
      p_answers: [{ question_id: question.data as string, option_id: entrant.optionId }],
    });
    if (recorded.error) throw new Error(`record_participation failed: ${recorded.error.message}`);
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('an operator filters the participants list and draws over what is left', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // provision_customer marks the owner's password provisional, so the first
  // browser sign-in lands on the change-password screen — the same step
  // draw-flow.spec.ts takes, and the reason the API client above could seed
  // with the password this one has to replace.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // (1) From AUDIENCE, beside Members. Located through the section heading
  // rather than by the link alone, because the link existing somewhere is not
  // the claim — where it lives is.
  const audience = page
    .locator('nav > div')
    .filter({ has: page.getByText('Audience', { exact: true }) });
  await audience.getByRole('link', { name: 'Participations' }).click();
  await expect(page).toHaveURL(/\/participations$/);

  const rows = page.getByTestId('participation-row');
  await expect(rows).toHaveCount(4);

  // (2) The answer filter is not offered until a promotion is chosen — a right
  // answer belongs to one — and the row says so instead of rendering a dead
  // control.
  await expect(page.getByTestId('participation-answer-filter-note')).toBeVisible();
  await expect(page.getByTestId('participation-answered-filter')).toHaveCount(0);

  await page.getByTestId('participation-promotion-filter').selectOption(promotionId);
  await expect(rows).toHaveCount(4);

  await page.getByTestId('participation-answered-filter').selectOption('yes');
  await expect(rows).toHaveCount(2);
  for (const name of RIGHT_ANSWERERS) await expect(rows.filter({ hasText: name })).toHaveCount(1);
  for (const name of WRONG_ANSWERERS) await expect(rows.filter({ hasText: name })).toHaveCount(0);

  // (3) The size of the hat, stated before anything is drawn.
  await page.getByTestId('open-draw-panel').click();
  await expect(page.getByTestId('draw-hat-summary')).toContainText('2 entries in the hat');

  // One unit of the two, so there is something to draw in the second round.
  // Located inside the dialog rather than by its label: the label is a sentence
  // this block is still rewriting, and the number of units is not.
  const dialog = page.getByTestId('run-draw-dialog');
  await dialog.locator('input[type="number"]').fill('1');
  await page.getByTestId('run-draw').click();

  // (4) One prize, one name, and the name is one of the two who answered
  // correctly — never one of the two who did not.
  const winners = page.getByTestId('draw-panel-winner');
  await expect(winners).toHaveCount(1, { timeout: 15_000 });
  const firstWinner = nameOf((await winners.first().innerText()).trim());
  expect(RIGHT_ANSWERERS).toContain(firstWinner);

  // (5) The second round. The list is re-read from the server — the draw
  // deliberately does not revalidate the route it was run from, so that an
  // operator's place in a keyset page survives it — and the winner's row now
  // says so.
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(
    rows.filter({ hasText: firstWinner }).getByTestId('participation-already-won'),
  ).toHaveText('Yes');
  // And nobody else's row moved: exactly one of the two says Yes.
  await expect(rows.getByTestId('participation-already-won').filter({ hasText: 'Yes' })).toHaveCount(
    1,
  );

  await page.getByTestId('open-draw-panel').click();
  await expect(page.getByTestId('draw-hat-summary')).toContainText('1 entry in the hat');
  await expect(page.getByTestId('draw-hat-excluded')).toContainText(
    '1 who already won in this promotion',
  );

  await page.getByTestId('run-draw').click();
  const second = page.getByTestId('draw-panel-winner');
  await expect(second).toHaveCount(1, { timeout: 15_000 });
  const secondWinner = nameOf((await second.first().innerText()).trim());
  expect(secondWinner).not.toBe(firstWinner);
  expect(RIGHT_ANSWERERS).toContain(secondWinner);
});

/**
 * The listener out of one announced winner — "<prize> — <listener>".
 *
 * A function rather than an inline split so that a line that does not have that
 * shape FAILS here, naming what it saw, instead of yielding an empty string that
 * every later `toContain` would quietly match nothing against.
 */
function nameOf(announced: string): string {
  const [, name] = announced.split(' — ');
  if (!name) throw new Error(`a winner was announced in an unexpected shape: "${announced}"`);
  return name;
}
