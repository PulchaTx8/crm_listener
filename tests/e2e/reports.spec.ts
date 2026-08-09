import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { WORKER_TICK_SECRET_FOR_TESTS } from '../whatsapp-test-env';
import { provisionCustomer } from './provision';

/**
 * Block 8b's round trip: filter a screen, export it, run the tick, download the
 * file.
 *
 * WHAT ONLY THIS FILE CAN PROVE. 22_reports.test.sql exercises the SQL,
 * tests/isolation/reports.test.ts exercises the RPCs with real sessions, and
 * neither ever runs the worker or opens a file. The three things below live
 * nowhere else:
 *
 *   1. That the tick actually claims, generates, uploads and finishes a run --
 *      the whole path through generate.ts, the writers and the storage client,
 *      which no other test invokes at all.
 *   2. That the provenance block reaches the bytes. Every unit test asserts the
 *      LINES; this asserts they survive into the file an operator downloads.
 *   3. That the screen's Export button carries the screen's own filters, which
 *      is the block's entire ergonomic claim.
 *
 * FIXTURE SETUP IS RPC-ONLY, the same choice dashboards.spec.ts makes and for
 * the same reason: what this file proves is the export path, not how a listener
 * gets created. members-flow.spec.ts already owns that.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const ownerEmail = `reports-owner-${stamp}@example.test`;
const ownerInitialPassword = `Init-${stamp}-aA1!`;
const ownerChosenPassword = `Chosen-${stamp}-aA1!`;
const platformAdminEmail = `reports-admin-${stamp}@example.test`;
const platformAdminPassword = `Admin-${stamp}-aA1!`;

// No organizationId here, and its absence is the point: requestReportAction
// derives the Organization from the Station ids through the caller's own
// client, so nothing in this journey ever names it.
let companyId: string;

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`could not create a profile for ${email}: ${profileError.message}`);
  return data.user.id;
}

async function signInAs(email: string, password: string) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

/**
 * What pg_cron calls. Driven by hand here, because Playwright's stack has no
 * cron: the endpoint is the same one production hits, secret and all.
 */
async function runWorkerTick(baseURL: string): Promise<Record<string, unknown>> {
  // The same fixed value the webServer is started with. Pinned in one module so
  // the server and the caller cannot disagree about it -- whatsapp-boundary
  // .spec.ts leans on the identical arrangement for its HMAC.
  const response = await fetch(`${baseURL}/api/worker/tick`, {
    method: 'POST',
    headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
  });
  if (!response.ok) throw new Error(`worker tick returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

interface ReportDrain {
  claimed?: number;
  ready?: number;
  failed?: number;
  error?: string;
}

/**
 * Tick until nothing is left QUEUED.
 *
 * THE QUEUE IS GLOBAL TO THE INSTALLATION, and the first version of this file
 * did not account for it: claim_report_run takes the OLDEST queued run in the
 * whole database, so runs left behind by tests/isolation/reports.test.ts (which
 * requests several and never runs a worker) were claimed instead of this one.
 * The tick reported claimed: 1, ready: 1 -- perfectly true, about somebody
 * else's row -- and the Download button never appeared.
 *
 * Draining first makes the assertion after the export exact rather than
 * probabilistic: one tick, one run, and it is this one.
 */
async function drainQueue(baseURL: string, limit = 20): Promise<void> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const tick = await runWorkerTick(baseURL);
    const reports = (tick.reports ?? {}) as ReportDrain;
    if (reports.error) throw new Error(`the report drain failed while draining: ${reports.error}`);
    if (!reports.claimed) return;
  }
  throw new Error(`the report queue was still not empty after ${limit} ticks`);
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(platformAdminEmail, platformAdminPassword);
  const { error: adminError } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (adminError) throw new Error(`could not seed platform admin: ${adminError.message}`);

  const ownerUserId = await createAuthUser(ownerEmail, ownerInitialPassword);
  const adminClient = await signInAs(platformAdminEmail, platformAdminPassword);
  ({ company_id: companyId } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: `Reports Org ${stamp}`,
    companyName: `Reports Station ${stamp}`,
  }));

  // One listener, so the export has a row. Created as the owner, who bypasses
  // has_permission for their own Organization.
  const ownerClient = await signInAs(ownerEmail, ownerInitialPassword);
  const { error: memberError } = await ownerClient.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: `Carried Listener ${stamp}`,
    p_phone: `+55119${String(stamp).slice(-8)}`,
  });
  if (memberError) throw new Error(`create_member failed: ${memberError.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test('a listeners export goes from the screen to a downloaded file', async ({ page, baseURL }) => {
  // provision_customer signs the owner in with a provisional password, so the
  // first login goes through the change-password screen -- the same path
  // dashboards.spec.ts walks.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerInitialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // provision_customer sets must_change_password (0016) regardless of how the
  // password was chosen -- the trap Block 5a's handoff describes, cleared here
  // through the real screen, exactly as dashboards.spec.ts does.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerChosenPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerChosenPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Anything another suite left queued, cleared before the run this test cares
  // about exists. See drainQueue's own comment for why this is not optional.
  await drainQueue(baseURL ?? 'http://localhost:3000');

  // The export starts on the screen the operator was already looking at.
  await page.goto('/members');
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();

  // exact, and the fixture listener is deliberately NOT named "Exported":
  // Playwright matches an accessible name by substring, so a row action
  // labelled "Actions for Exported Listener …" answered to `name: 'Export'`
  // and made this locator ambiguous. Both halves of that fix are kept --
  // exactness here, and a fixture name that does not contain the word.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/filters currently on this screen/i)).toBeVisible();
  await page.getByRole('button', { name: 'CSV', exact: true }).click();

  // The dialog lands the operator on /reports with the run pending.
  await expect(page).toHaveURL(/\/reports/);
  await expect(page.getByRole('heading', { name: 'My reports' })).toBeVisible();
  await expect(page.getByText(/Queued…|Generating…/)).toBeVisible();

  // The worker. In production pg_cron fires this every ten seconds; here it is
  // called once, which is all a single run needs.
  const tick = await runWorkerTick(baseURL ?? 'http://localhost:3000');
  // `toBeTruthy()` was the first version of this assertion and it was worse
  // than useless: the drain reports a failure as `{ error }`, which is truthy,
  // so a tick that generated nothing at all passed. The shape is asserted, and
  // the error text is put in the message so a failure here says WHY rather than
  // leaving it to be dug out of the table afterwards.
  const reports = (tick.reports ?? {}) as ReportDrain;
  expect(reports.error ?? null, 'the report drain reported an error').toBeNull();
  expect(reports.claimed, 'the tick claimed no run').toBe(1);
  expect(reports.ready, 'the tick claimed a run and did not finish it').toBe(1);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 15_000 });

  // The download itself, and its contents. A signed URL is minted at the click
  // and never rendered into the page, so the only way to reach the bytes is to
  // click.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');

  // The provenance block, in the bytes rather than in a unit test's return
  // value: this is the only assertion in the repository that it survives the
  // writer, the upload and the download.
  expect(body).toContain('# PulchaTX report');
  expect(body).toContain('# Report: Listeners');
  // The owner holds members.view, so nothing is withheld -- and the file says
  // so explicitly rather than staying silent, which is the whole contract.
  expect(body).toContain('Withheld columns: none');
  // The header row and the listener seeded above.
  expect(body).toContain('Name');
  expect(body).toContain(`Carried Listener ${stamp}`);
});
