import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { WORKER_TICK_SECRET_FOR_TESTS } from '../whatsapp-test-env';

/**
 * THE ACCEPTANCE JOURNEY — master spec §35.
 *
 * Every stage below is already covered by one of this suite's other journeys.
 * This one exists because none of them covers the SEAM: the order a real
 * customer meets these screens in, from an empty database through to an audited
 * delivery. It is slow and it duplicates coverage on purpose — §35 is the
 * master spec's own definition of "the product is done", and until this file
 * existed it had only ever been satisfied in pieces.
 *
 * NO RPC SHORTCUT ON ANY STAGE THAT HAS A SCREEN — including the second
 * Station, which the console's AddStationForm creates over add_company. The
 * service key appears exactly once, to make the first platform admin, because
 * `platform_admins` accepts no client write (0006) and that is deliberate.
 *
 * Stages are `test.step`s so a failure names the §35 stage rather than a line
 * number.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const adminEmail = `e2e-accept-admin-${stamp}@example.test`;
const adminPassword = `Accept-admin-${stamp}-pw`;
const ownerEmail = `e2e-accept-owner-${stamp}@example.test`;
const ownerPassword = `Accept-owner-${stamp}-chosen`;
const colleagueEmail = `e2e-accept-colleague-${stamp}@example.test`;
const colleaguePassword = `Accept-colleague-${stamp}-pw`;
const organizationName = `Accept Org ${stamp}`;
// Alpha before Beta, deliberately. Every Station-scoped screen defaults to the
// first Station this owner can reach, so naming them in order keeps the whole
// journey on one Station without a switch on every screen -- and the second
// exists to prove the cross-access block, which needs nothing in it.
const stationOne = `Accept Alpha ${stamp}`;
const stationTwo = `Accept Beta ${stamp}`;
const roleName = `Accept Audience ${stamp}`;
const listenerOne = `Accept Listener One ${stamp}`;
const prizeName = `Accept Prize ${stamp}`;
const promotionName = `Accept Promotion ${stamp}`;
const listenerOnePhone = `+5511${String(970000000 + (stamp % 1000))}`;

const createdUserIds: string[] = [];

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create the platform admin: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await admin.from('profiles').insert({ id: data.user.id, email: adminEmail });
  await admin.from('platform_admins').insert({ user_id: data.user.id });

  // The invitation limiter is keyed by a hash of the CALLER'S IP, and every
  // local test shares 127.0.0.1 -- ten accepted invitations per window across
  // the whole suite and this journey's own iterations. Cleared here so a
  // control that is working correctly cannot masquerade as a broken journey;
  // the limiter itself is proved by tests/unit/rate-limit.test.ts and by
  // tests/isolation/contact-requests.test.ts, so nothing is lost by resetting
  // its counter before a run that is not about it.
  await admin.from('rate_limit_counters').delete().like('key', 'invite-accept:%');
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

/** Records a user this journey created through the UI, so afterAll can remove it. */
async function trackUser(email: string): Promise<string> {
  const { data, error } = await admin.from('profiles').select('id').eq('email', email).single();
  expect(error, `no profile row for ${email}`).toBeNull();
  if (!data) throw new Error(`no profile row for ${email}`);
  createdUserIds.push(data.id);
  return data.id;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('§35 — from an empty database to an audited delivery', async ({ page, browser }) => {
  // Fifteen stages over ten screens, each waiting on a real server action.
  test.setTimeout(300_000);

  let provisionalPassword = '';
  let inviteUrl = '';
  // The owner's browser context outlives the stage that creates it: every stage
  // from here on is work that owner does, and re-signing in per stage would
  // make the journey slower without proving anything more.
  let ownerContext!: Awaited<ReturnType<typeof browser.newContext>>;
  let ownerPage!: Page;

  await test.step('a platform admin provisions the customer', async () => {
    await signIn(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/app$/);

    // Reached through the sidebar rather than by URL: the platform links render
    // only for a platform admin, so arriving this way also asserts the scoping.
    await page.getByRole('link', { name: 'Customers' }).click();
    await expect(page).toHaveURL(/\/admin\/customers$/);

    await page.getByTestId('customer-create').click();
    await page.getByPlaceholder('Organization name').fill(organizationName);
    await page.getByPlaceholder('Company (Station) name').fill(stationOne);
    await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
    await page.getByRole('button', { name: 'Provision', exact: true }).click();

    // Shown once and stored nowhere, which is why the dialog stays open.
    const revealed = page.locator('code').first();
    await expect(revealed).toBeVisible({ timeout: 15_000 });
    provisionalPassword = (await revealed.innerText()).trim();
    expect(provisionalPassword.length).toBeGreaterThanOrEqual(16);
    expect(page.url()).not.toContain(provisionalPassword);

    await trackUser(ownerEmail);
  });

  await test.step('the same console adds the second Station', async () => {
    // §35 asks for two Companies, and this is the screen that makes one:
    // AddStationForm in the customer record dialog, over add_company, which is
    // platform-admin only -- which is why it lives in the console rather than
    // on the customer's own screens.
    await page.keyboard.press('Escape');
    await page.reload();
    const row = page.locator('[data-testid="company-row"]', { hasText: stationOne });
    await row.getByRole('button', { name: stationOne, exact: true }).click();
    await page.getByRole('tab', { name: 'Stations' }).click();

    await page.getByPlaceholder('New Station name').fill(stationTwo);
    await page.getByRole('button', { name: 'Add Station' }).click();

    // Asserted inside the dialog: the grid behind it also gains a row with this
    // name, and a bare getByText resolves to both.
    await expect(page.getByRole('dialog').getByText(stationTwo)).toBeVisible({ timeout: 15_000 });
  });

  await test.step('the owner takes the account and reaches both Stations', async () => {
    const customerContext = await browser.newContext();
    const owner = await customerContext.newPage();

    await signIn(owner, ownerEmail, provisionalPassword);
    // The provisional password travels outside the system and is treated as
    // compromised, so the gate is unconditional.
    await expect(owner).toHaveURL(/\/change-password$/);

    await owner.getByPlaceholder('New password').fill(ownerPassword);
    await owner.getByPlaceholder('Repeat the password').fill(ownerPassword);
    await owner.getByRole('button', { name: 'Save' }).click();
    await expect(owner).toHaveURL(/\/app$/);

    // Both Stations, and the console is not theirs.
    await expect(owner.locator('[data-testid="station-card"]')).toHaveCount(2);
    await expect(owner.getByRole('link', { name: 'Customers' })).toHaveCount(0);

    ownerPage = owner;
    ownerContext = customerContext;
  });

  await test.step('a listener is registered at the first Station', async () => {
    await ownerPage.getByRole('link', { name: 'Members' }).click();
    await expect(ownerPage).toHaveURL(/\/members$/);

    await ownerPage.getByTestId('member-create').click();

    // Two steps by design: this Organization's audience is shared across its
    // Stations, so the same person entering at two of them must be one record.
    const checkForm = ownerPage.locator('[data-testid="member-check-form"]');
    await expect(checkForm).toBeVisible();
    // The Station is chosen on the CHECK form rather than on the register form,
    // and that is not cosmetic: the duplicate search is Organization-scoped
    // (find_member_by_identifier, 0033) while the LINK is per Station, so the
    // screen has to know which Station before it can offer to link.
    await checkForm.getByLabel('Station being registered at').selectOption({ label: stationOne });
    await checkForm.getByLabel('Phone').fill(listenerOnePhone);
    await checkForm.getByRole('button', { name: 'Check for an existing listener' }).click();

    const registerForm = ownerPage.locator('[data-testid="register-member-form"]');
    await expect(registerForm).toBeVisible();
    await registerForm.getByLabel('Name').fill(listenerOne);
    await registerForm.getByRole('button', { name: 'Register listener' }).click();
    await expect(registerForm.getByText('Registered.')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('a colleague is invited, restricted to one Station', async () => {
    await ownerPage.reload();
    await ownerPage.getByRole('link', { name: 'Roles' }).click();
    await expect(ownerPage).toHaveURL(/\/roles$/);

    await ownerPage.getByTestId('role-create').click();
    await ownerPage.getByRole('tab', { name: 'Powers' }).click();
    await ownerPage.getByLabel('See the audience and their history').check();
    await ownerPage.getByRole('tab', { name: 'Role data' }).click();
    await ownerPage.getByLabel('Name').fill(roleName);
    await ownerPage.getByTestId('role-save').click();

    await expect(
      ownerPage.locator('[data-testid="role-row"]', { hasText: roleName }),
    ).toBeVisible({ timeout: 15_000 });

    await ownerPage.getByRole('link', { name: 'Team' }).click();
    await expect(ownerPage).toHaveURL(/\/team$/);

    await ownerPage.getByTestId('team-invite').click();
    const inviteForm = ownerPage.locator('form', {
      has: ownerPage.getByPlaceholder("Colleague's e-mail"),
    });
    await inviteForm.getByPlaceholder("Colleague's e-mail").fill(colleagueEmail);
    await inviteForm.getByRole('combobox').selectOption({ label: roleName });
    // The first Station only. Everything after this stage is about what that
    // restriction actually does.
    await inviteForm.getByLabel(stationOne).check();
    await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

    const linkBox = ownerPage.locator('code').first();
    await expect(linkBox).toBeVisible({ timeout: 15_000 });
    inviteUrl = (await linkBox.innerText()).trim();
    expect(inviteUrl).toContain('/invite/');
  });

  await test.step('the colleague cannot reach the Station they were not given', async () => {
    const colleagueContext = await browser.newContext();
    const colleague = await colleagueContext.newPage();

    await colleague.goto(inviteUrl);
    await colleague.getByPlaceholder('Choose a password').fill(colleaguePassword);
    await colleague.getByPlaceholder('Repeat the password').fill(colleaguePassword);
    await colleague.getByRole('button', { name: 'Create my account' }).click();
    await expect(colleague).toHaveURL(/\/login/);

    await trackUser(colleagueEmail);

    await signIn(colleague, colleagueEmail, colleaguePassword);
    await expect(colleague).toHaveURL(/\/app$/);

    // THE CROSS-ACCESS BLOCK §35 NAMES. Exactly one Station card, and it is the
    // one they were given -- the other is not hidden from the nav, it is
    // unreachable, because RLS answers the query rather than the UI filtering.
    await expect(colleague.locator('[data-testid="station-card"]')).toHaveCount(1);
    await expect(
      colleague.locator('[data-testid="station-card"]', { hasText: stationOne }),
    ).toBeVisible();
    await expect(colleague.getByText(stationTwo)).toHaveCount(0);

    await colleagueContext.close();
  });

  await test.step('a prize is registered, stocked and reserved', async () => {
    // Reloaded first: the invite dialog is deliberately left open on success so
    // the accept link cannot be lost, and a modal over the shell makes every
    // sidebar link inert.
    await ownerPage.reload();
    await ownerPage.getByRole('link', { name: 'Stock' }).click();
    await expect(ownerPage).toHaveURL(/\/inventory$/);

    await ownerPage.getByTestId('prize-create').click();
    const prizeForm = ownerPage.locator('[data-testid="prize-form"]');
    await expect(prizeForm).toBeVisible();
    await prizeForm.getByLabel('Name').fill(prizeName);
    await prizeForm.getByRole('button', { name: 'Register prize' }).click();
    await expect(prizeForm.getByText('Prize registered.')).toBeVisible({ timeout: 15_000 });

    await prizeForm.getByRole('button', { name: 'View prize' }).click();
    await expect(ownerPage.getByRole('heading', { name: prizeName, level: 2 })).toBeVisible();

    await ownerPage.getByRole('tab', { name: 'Stock movements' }).click();
    const entryForm = ownerPage.locator('[data-testid="stock-entry-form"]');
    await expect(entryForm).toBeVisible();
    await entryForm.getByLabel('Quantity').fill('50');
    await entryForm.getByRole('button', { name: 'Add stock' }).click();

    const reserveForm = ownerPage.locator('[data-testid="reserve-form"]');
    await expect(reserveForm).toBeVisible();
    await reserveForm.getByLabel('Quantity').fill('10');
    await reserveForm.getByLabel('Note').fill('Reserved for the acceptance journey');
    await reserveForm.getByRole('button', { name: 'Reserve stock' }).click();
  });

  await test.step('a promotion is created and the prize committed to it', async () => {
    await ownerPage.goto('/promotions');
    // No Station switch: this screen defaults to the first Station the owner
    // reaches, which is where the listener above was registered. A promotion
    // created at the other one refuses that listener's entry with a sentence
    // about linking -- correct behaviour, and a confusing way to fail a test.
    await ownerPage.getByTestId('promotion-create').click();

    await ownerPage.getByTestId('promotion-name').fill(promotionName);
    // Wall-clock in the Station's own zone, which is what the form asks for --
    // the hidden field beside it converts.
    await ownerPage.getByTestId('promotion-starts').fill(localWallClock(-1));
    await ownerPage.getByTestId('promotion-ends').fill(localWallClock(30));
    await ownerPage.getByRole('button', { name: 'Register', exact: true }).click();

    const promotionRow = ownerPage.locator('[data-testid="promotion-row"]', {
      hasText: promotionName,
    });
    await expect(promotionRow).toBeVisible({ timeout: 15_000 });

    // Escape rather than reload: the registration dialog stays open over the
    // grid and the row behind it is inert, but the grid itself is already
    // showing the row -- Block 3c patches it in place rather than re-reading.
    await ownerPage.keyboard.press('Escape');
    await expect(promotionRow).toBeVisible({ timeout: 15_000 });
    await promotionRow.getByRole('button', { name: promotionName, exact: true }).click({
      timeout: 15_000,
    });
    await ownerPage.getByTestId('promotion-tab-prizes').click();
    await ownerPage.getByTestId('prize-link-open').click();
    const linkForm = ownerPage.locator('[data-testid="prize-link-form"]');
    await expect(linkForm).toBeVisible();
    // The option reads "<name> — <n> available", so it is found by its text and
    // selected by its value. selectOption({label}) takes no pattern.
    const select = linkForm.getByTestId('prize-link-select');
    const optionValue = await select.locator('option', { hasText: prizeName }).getAttribute('value');
    expect(optionValue, 'the prize is not offered for linking').toBeTruthy();
    await select.selectOption(optionValue as string);
    await linkForm.getByTestId('prize-link-quantity').fill('2');
    await linkForm.getByTestId('prize-link-save').click();

    await expect(ownerPage.getByTestId('promotion-prize-row')).toHaveCount(1, { timeout: 15_000 });
  });

  await test.step('an entry is recorded by hand', async () => {
    await ownerPage.getByTestId('promotion-tab-participations').click();
    await ownerPage.getByTestId('promotion-participation-record-open').click();
    await expect(ownerPage.getByTestId('participation-record-form')).toBeVisible();
    await ownerPage.getByTestId('participation-full-name').fill(listenerOne);
    await ownerPage.getByTestId('participation-phone').fill(listenerOnePhone);
    await ownerPage.getByTestId('participation-record-submit').click();

    // The outcome, asserted. A submit that quietly refused would leave the draw
    // below with nothing to draw from, and the failure would surface three
    // stages later as "no winners" -- which is a much worse place to read it.
    await expect(ownerPage.getByTestId('participation-record-status')).toHaveText('Counted', {
      timeout: 15_000,
    });
    await expect(ownerPage.getByTestId('promotion-participations-valid')).toHaveText('1');
  });

  await test.step('the draw runs and produces a winner', async () => {
    await ownerPage.getByTestId('promotion-tab-prizes').click();
    // Waited for rather than clicked straight through: the tab switch is a
    // client render, and a click that lands before it finishes goes nowhere and
    // leaves the journey on /promotions with no error to read.
    const openDraws = ownerPage.getByTestId('open-draws');
    await expect(openDraws).toBeVisible({ timeout: 15_000 });
    await openDraws.click();
    await ownerPage.waitForURL(/\/draws$/, { timeout: 30_000 });

    await expect(ownerPage.getByTestId('run-draw-dialog')).toBeVisible();
    await ownerPage.getByTestId('run-draw').click();

    const winners = ownerPage.getByTestId('draw-winners');
    await expect(winners).toBeVisible({ timeout: 30_000 });

    // The seed and the algorithm version are what make a draw auditable
    // afterwards -- a winner without them is a name somebody typed.
    await expect(ownerPage.getByTestId('draw-seed')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(ownerPage.getByTestId('winner-status-1')).toHaveText('AWAITING_PICKUP');
  });

  await test.step('the prize is delivered with a private receipt', async () => {
    await ownerPage.getByTestId('winner-deliver').click();
    await expect(ownerPage.getByTestId('winner-status-1')).toHaveText('DELIVERED', {
      timeout: 15_000,
    });

    await ownerPage.getByTestId('receipt-input').setInputFiles({
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('a photograph of the handover'),
    });
    await ownerPage.getByTestId('receipt-attach').click();
    await expect(ownerPage.getByTestId('winner-receipt')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('the prize goes back to stock and the ledger says so', async () => {
    // §35's uncollected branch, through the screen an operator uses. The
    // clock-driven RETURN_PENDING path -- where sweep_pickup_deadlines moves a
    // winner rather than a person deciding to -- is deadline.spec.ts's, and
    // this journey does not repeat it.
    await ownerPage.getByTestId('winner-cancel_delivery').click();
    await ownerPage.getByLabel('Reason').fill('the listener never came for it');
    await ownerPage.getByRole('button', { name: 'Confirm' }).click();
    await expect(ownerPage.getByTestId('winner-status-1')).toHaveText('AWAITING_PICKUP', {
      timeout: 15_000,
    });

    await ownerPage.getByTestId('winner-return').click();
    await ownerPage.getByLabel('Reason').fill('back on the shelf for the next promotion');
    await ownerPage.getByRole('button', { name: 'Confirm' }).click();
    await expect(ownerPage.getByTestId('winner-status-1')).toHaveText('RETURNED', {
      timeout: 15_000,
    });
  });

  await test.step('a report is requested and downloaded', async () => {
    // Exported from the screen the data is on rather than from /reports: an
    // export carries the filters currently in front of the operator, which is
    // the whole reason the button lives there.
    await ownerPage.goto('/members');
    await ownerPage.getByRole('button', { name: 'Export', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'CSV', exact: true }).click();

    await expect(ownerPage).toHaveURL(/\/reports/);
    await expect(ownerPage.getByRole('heading', { name: 'My reports' })).toBeVisible();

    // The worker. In production pg_cron fires this every ten seconds through
    // pg_net; the local stack has no app.worker_tick_url, so it is driven here.
    //
    // A LOOP, not one call, and the reason is worth keeping: the drain claims
    // ONE run per tick, so a database carrying queued runs from an earlier
    // iteration hands this journey somebody else's work and leaves its own
    // report Queued. A single tick passed its own assertions and still left the
    // screen empty, which is a confusing way to learn that.
    const download = ownerPage.getByRole('button', { name: 'Download' }).first();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tick = await fetch('http://localhost:3000/api/worker/tick', {
        method: 'POST',
        headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
      });
      expect(tick.ok, 'the worker tick refused').toBeTruthy();
      const drained = (await tick.json()) as { reports?: { error?: string } };
      expect(drained.reports?.error ?? null, 'the report drain reported an error').toBeNull();

      await ownerPage.reload();
      if (await download.isVisible().catch(() => false)) break;
    }

    await expect(download, 'the report never became downloadable').toBeVisible({
      timeout: 15_000,
    });
  });

  await test.step('the audit trail carries what was done', async () => {
    await ownerPage.goto('/audit');
    await expect(ownerPage.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

    // Pseudonymised by construction -- ids, not names -- so what is asserted is
    // that the work above reached the trail under its human label, read through
    // audit_logs' own policies as this Organization's owner. `winner_transition`
    // is what the delivery, the undo and the return each wrote.
    await expect(ownerPage.getByText('Winner status changed').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(ownerPage.getByText('Prize created').first()).toBeVisible();
  });

  await ownerContext.close();
});

/**
 * A local wall-clock string for a `datetime-local` input, offset by days from
 * now. The form's hidden sibling converts it to the Station's zone, so what is
 * typed here is what an operator would type.
 */
function localWallClock(offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
