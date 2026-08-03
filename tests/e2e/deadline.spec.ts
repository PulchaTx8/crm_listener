import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
  LOCAL_SUPABASE_DB_URL,
} from '../local-supabase';

/**
 * Block 6d through the screen, and through the clock: a prize is drawn, its
 * deadline is set to an hour ago, the sweep runs, an operator finds it parked
 * in `pending_return`, gives the listener three more days, hands the prize
 * over, and the ledger for that one prize reads DRAW, RETURN_PENDING,
 * RETURN_PENDING_CANCEL, DELIVERY — the whole journey, in order.
 *
 * `sweep_pickup_deadlines` (0094) is CALLed directly against the local
 * Postgres port, as `postgres` — the role that owns every migration in this
 * project, exactly as `apply_winner_transition` and the rest of the chain it
 * drives assume the caller is. Two things rule out the service-role client
 * that every other fixture in this suite seeds through:
 *   - the procedure's EXECUTE grant is owner-only (0094's own header): a
 *     service_role CALL would fail every winner (no EXECUTE on
 *     apply_winner_transition), have the failure caught by the sweep's broad
 *     handler, and still return success, having done nothing;
 *   - a PROCEDURE that commits per iteration cannot be invoked through
 *     PostgREST/supabase-js at any privilege — CALL is transaction control,
 *     and REST has no such statement.
 * `LOCAL_SUPABASE_DB_URL` (../local-supabase) is the same target
 * tests/isolation/harness.ts and draw-flow.spec.ts already connect to for the
 * identical reason (draw-flow.spec.ts's own comment: a write no role, not even
 * service_role, holds a grant for).
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-deadline-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-deadline-admin-${stamp}-pw`;
const ownerEmail = `e2e-deadline-owner-${stamp}@example.test`;
const ownerPassword = `Owner-deadline-${stamp}-provisional`;
const ownerFinalPassword = `Owner-deadline-${stamp}-chosen`;
const stationTimeZone = 'America/Sao_Paulo';
const prizeName = `Deadline Prize ${stamp}`;
const promotionName = `Deadline Promo ${stamp}`;
const listenerName = `Deadline Listener ${stamp}`;

const createdUserIds: string[] = [];
let prizeId = '';
let winnerId = '';

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

/**
 * `YYYY-MM-DDTHH:mm` in the given zone — the shape `<input type="datetime-local">`
 * wants, the same conversion promotions/zone.ts's own `toZonedDateTime` performs
 * for the real form. Reimplemented locally rather than imported: no spec in this
 * suite imports a `src/` module (draw-flow.spec.ts's own comment gives the
 * reason — these screens are other blocks' to prove through their own path),
 * and a handful of lines here does not change that.
 */
function stationWallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

test.beforeAll(async () => {
  const adminId = await createUser(platformAdminEmail, platformAdminPassword);
  await admin.from('platform_admins').insert({ user_id: adminId });
  const ownerId = await createUser(ownerEmail, ownerPassword);

  const adminClient = await signIn(platformAdminEmail, platformAdminPassword);
  const provisioned = await adminClient.rpc('provision_customer', {
    p_user_id: ownerId,
    p_organization_name: `Deadline Org ${stamp}`,
    p_company_name: `Deadline Station ${stamp}`,
    p_timezone: stationTimeZone,
  });
  if (provisioned.error) throw new Error(`provision failed: ${provisioned.error.message}`);
  const { company_id: companyId } = provisioned.data as { company_id: string };

  const owner = await signIn(ownerEmail, ownerPassword);

  const prize = await owner.rpc('create_prize', {
    p_company_id: companyId,
    p_name: prizeName,
  });
  if (prize.error) throw new Error(`create_prize failed: ${prize.error.message}`);
  prizeId = prize.data as string;

  await owner.rpc('record_stock_entry', {
    p_company_id: companyId,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: 1,
  });

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
  const promotionId = promotion.data as string;

  await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prizeId,
    p_quantity: 1,
  });

  const member = await owner.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: listenerName,
  });
  await owner.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: member.data as string,
    p_participated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_source: 'MANUAL',
    p_answers: [],
  });

  // Closed, which is the ordinary case for a draw — the same reason and the
  // same direct connection draw-flow.spec.ts uses for its own promotion:
  // service_role holds no UPDATE on promotions, and update_promotion is a
  // seventeen-argument door whose whole field set would have to be restated
  // here to move one timestamp.
  const setup = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await setup.connect();
  try {
    await setup.query(
      "update public.promotions set ends_at = now() - interval '1 minute' where id = $1",
      [promotionId],
    );
  } finally {
    await setup.end();
  }

  // The draw is fixture here, exactly as delivery-flow.spec.ts treats it:
  // draw-flow.spec.ts is what proves the draws screen itself. One unit, one
  // eligible listener: one winner, and this is the DRAW row the movements
  // ledger will show last.
  const drawn = await owner.rpc('run_draw', { p_promotion_id: promotionId, p_units: null });
  if (drawn.error) throw new Error(`run_draw failed: ${drawn.error.message}`);
  const drawId = drawn.data as string;

  // From here on, everything goes through the direct connection as `postgres`
  // — the migration-owning role — for the two reasons in this file's header
  // comment: setting deadline_at to the past is not something any RPC in this
  // schema exposes (6a's own freeze, D5), and CALLing the procedure needs a
  // role holding its owner-only EXECUTE grant, which no PostgREST client can
  // reach in any case.
  const clock = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await clock.connect();
  try {
    const { rows: winners } = await clock.query<{ id: string }>(
      'select id from public.winners where draw_id = $1',
      [drawId],
    );
    if (winners.length !== 1) {
      throw new Error(`expected exactly one winner for draw ${drawId}, found ${winners.length}`);
    }
    winnerId = winners[0]!.id;

    await clock.query(
      "update public.winners set deadline_at = now() - interval '1 hour' where id = $1",
      [winnerId],
    );

    // Not through service_role, and not waiting for pg_cron's own hourly
    // trigger — Task 4 verified the schedule separately (12b_deadline_sweep
    // and this suite's own runbook show how). This CALL is the procedure
    // running exactly as `postgres` calling `cron.schedule` makes it run in
    // production.
    await clock.query('call public.sweep_pickup_deadlines()');

    const { rows: swept } = await clock.query<{ status: string }>(
      'select status from public.winners where id = $1',
      [winnerId],
    );
    if (swept[0]?.status !== 'RETURN_PENDING') {
      throw new Error(
        `sweep did not park the winner in RETURN_PENDING; status is ${swept[0]?.status ?? '(missing)'}`,
      );
    }
  } finally {
    await clock.end();
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('the deadline expires, an operator reopens it and hands the prize over, and the ledger reads DRAW, RETURN_PENDING, RETURN_PENDING_CANCEL, DELIVERY', async ({
  page,
}) => {
  // Two screens neither of which existed in the suite before this route, one
  // of them a cold /pickups and one a cold /inventory/movements compile under
  // `next dev` — the default 30s test timeout is tight for that on a busy
  // machine, the exact contention Task 10's own diagnosis measured for this
  // suite. Extended the same way participations-flow.spec.ts and
  // members-flow.spec.ts already extend theirs for the same reason.
  test.setTimeout(90_000);

  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(ownerEmail);
  await page.getByPlaceholder('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // --- /pickups, filtered to Return pending -------------------------------
  await page.getByRole('link', { name: 'Pickups' }).click();
  await expect(page).toHaveURL(/\/pickups$/);

  await page.getByTestId('pickup-status-filter').selectOption('RETURN_PENDING');
  await expect(page).toHaveURL(/status=RETURN_PENDING/);

  const row = page.getByTestId('pickup-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(listenerName);
  await expect(row).toContainText(prizeName);
  await expect(row.getByTestId('pickup-status')).toHaveText('Return pending');

  // --- reopen the deadline three days out ---------------------------------
  const reopenDeadline = stationWallClock(
    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    stationTimeZone,
  );
  await row.getByTestId('reopen-deadline').fill(reopenDeadline);
  await row
    .getByTestId('reopen-reason')
    .fill('the listener called — they are collecting it this week after all');
  await row.getByTestId('reopen-submit').click();

  await expect(row.getByTestId('pickup-status')).toHaveText('Awaiting pickup', {
    timeout: 15_000,
  });

  // --- hand the prize over -------------------------------------------------
  await row.getByTestId('winner-deliver').click();
  await expect(row.getByTestId('pickup-status')).toHaveText('Delivered', { timeout: 15_000 });

  // --- /inventory/movements, the whole journey for this one prize ----------
  await page.getByRole('link', { name: 'Movements' }).click();
  await expect(page).toHaveURL(/\/inventory\/movements$/);

  // Scoped to this one prize: a fresh Station holds no other movement, but
  // naming the filter is what makes this assertion about THIS journey rather
  // than about "whatever this Station happens to hold right now".
  await page.getByTestId('movement-prize-filter').selectOption(prizeId);
  await expect(page).toHaveURL(new RegExp(`prize=${prizeId}`));

  // SIX rows exist for this prize, not four: record_stock_entry and
  // link_prize_to_promotion (this file's own beforeAll, before the draw) each
  // write their own movement too (MANUAL_ENTRY, PROMOTION_LINK) — the brief's
  // "four rows for that prize" names the winner's own lifecycle, which is the
  // NEWEST four of the six the real ledger holds for a prize that was
  // registered and linked before anyone ever won it. Asserting 4 here would
  // have been the vacuous kind of assertion this block was warned against:
  // it would pass by coincidence if list_movements silently dropped a filter
  // and happened to also drop two rows.
  const movementRows = page.getByTestId('movement-row');
  await expect(movementRows).toHaveCount(6);

  // list_movements (0096) orders newest first, so the DOM reads the journey
  // backwards: DELIVERY, RETURN_PENDING_CANCEL, RETURN_PENDING, DRAW, then the
  // two setup movements. The block's own claim is the causal order — DRAW,
  // RETURN_PENDING, RETURN_PENDING_CANCEL, DELIVERY — so each row's Type cell
  // (the second <td>, after Date) is checked against that reversed sequence
  // rather than trusting a substring match: "Pending return"
  // (RETURN_PENDING's own label) is also a fragment of the From → To cell on
  // the RETURN_PENDING_CANCEL row immediately above it, so a `toContainText`
  // over the whole row would not actually discriminate between the two.
  const typeCell = (nth: number) => movementRows.nth(nth).locator('td').nth(1);
  await expect(typeCell(0)).toHaveText('Delivered to winner');
  await expect(typeCell(1)).toHaveText('Deadline reopened');
  await expect(typeCell(2)).toHaveText('Pending return');
  await expect(typeCell(3)).toHaveText('Draw');
  await expect(typeCell(4)).toHaveText('Linked to promotion');
  await expect(typeCell(5)).toHaveText('Manual entry');

  // The one row with no human behind it: sweep_pickup_deadlines runs under
  // pg_cron, which carries no auth.uid(), so RETURN_PENDING's own actor is
  // null and describeMovementActor (inventory/movements/list-params.ts) reads
  // that as "(deadline)" — never a name, because nobody did this, the
  // deadline did (0094's own comment). The other three were the owner acting
  // through the RPCs above; the owner's profile carries no full_name (this
  // fixture never sets one), so describeMovementActor's other branch renders
  // them "Unnamed operator" rather than "(deadline)" — the two are
  // deliberately not the same string, and this is the assertion that would
  // catch either one leaking into the other's row.
  const actorCell = (nth: number) => movementRows.nth(nth).getByTestId('movement-actor');
  await expect(actorCell(0)).toHaveText('Unnamed operator');
  await expect(actorCell(1)).toHaveText('Unnamed operator');
  await expect(actorCell(2)).toHaveText('(deadline)');
  await expect(actorCell(3)).toHaveText('Unnamed operator');
});
