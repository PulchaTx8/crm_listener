import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from '../src/lib/security/local-only.ts';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../tests/local-supabase.ts';

/**
 * Block 11c, D2. A demo Station with the whole cycle already visible.
 *
 * NOT `supabase/seed.sql`, deliberately: that file runs on every `db reset`,
 * which is what 1397 pgTAP assertions and 44 journeys start from. Putting rows
 * in front of them turns a demo convenience into a week of red suites whose
 * failures look like regressions in whatever block does the counting.
 *
 * Idempotent by Organization name: run it twice and nothing duplicates.
 *
 * IT DRIVES THE REAL RPCs ON REAL SESSIONS. They are permission-gated on
 * auth.uid(), so the service key would be refused rather than privileged; it is
 * used for exactly three things -- creating auth users, the platform_admins
 * insert no client may write (0006), and clearing the provisional-password flag
 * so the demo owner lands on a screen instead of on /change-password.
 */
const URL = process.env.SEED_SUPABASE_URL ?? LOCAL_SUPABASE_URL;
const SERVICE_KEY = process.env.SEED_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SEED_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY;

// Applied to whatever it ended up with, override or default, and before any
// client is built. The override is deliberately not called
// NEXT_PUBLIC_SUPABASE_URL, so a shell carrying the hosted environment cannot
// steer this script by accident.
//
// Caught here rather than left to throw: this runs at module scope, outside
// main()'s catch, and an uncaught throw prints a stack trace over the one
// sentence that actually tells the operator what happened.
try {
  assertLocalSupabase(URL);
} catch (cause) {
  console.error(`\nseed:demo refused to run - ${cause.message}`);
  process.exit(1);
}

const ORGANIZATION = 'Demo Broadcasting';
const STATION = 'Demo FM';
const SECOND_STATION = 'Demo AM';
const ADMIN_EMAIL = 'admin@demo.test';
const OWNER_EMAIL = 'owner@demo.test';
const PASSWORD = 'Demo-password-1';

const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const existing = await admin
    .from('organizations')
    .select('id')
    .eq('name', ORGANIZATION)
    .maybeSingle();

  if (existing.data) {
    // "The Organization exists" is NOT the same question as "the seed
    // finished", and the difference cost a debugging round on the very first
    // run: provision_customer succeeded, a later step failed, and the next run
    // then reported success over an Organization with nothing in it.
    //
    // There is no compensating teardown here on purpose. Deleting the users
    // this script creates runs into non-cascading foreign keys and the
    // at-least-one-owner trigger, so a half-written cleanup would leave a
    // different mess and claim to have tidied. `db:reset` is one command and it
    // is exact.
    const complete = await isComplete(existing.data.id);
    if (!complete) {
      console.error(
        `"${ORGANIZATION}" exists but its seeding did not finish -- an earlier run failed part-way.\n` +
          'Run `npm run db:reset` (then restart Kong) and seed again.',
      );
      process.exit(1);
    }
    console.log(`"${ORGANIZATION}" is already seeded. Nothing to do.`);
    await summarise(existing.data.id);
    printSignIn();
    return;
  }

  // 1. The platform admin. `platform_admins` accepts no client write (0006),
  // so this insert is what the service key exists for.
  const adminUser = await createUser(ADMIN_EMAIL, 'Demo Administrator');
  const promoted = await admin.from('platform_admins').insert({ user_id: adminUser });
  if (promoted.error) throw new Error(`platform_admins insert: ${promoted.error.message}`);

  // 2. The customer, provisioned exactly as the console provisions one --
  // signed in as the admin, because provision_customer is SECURITY DEFINER and
  // re-checks is_platform_admin() against auth.uid(), which the service key has
  // none of.
  const adminSession = await signIn(ADMIN_EMAIL);
  const ownerUser = await createUser(OWNER_EMAIL, 'Demo Owner');
  const provisioned = await rpc(adminSession, 'provision_customer', {
    p_user_id: ownerUser,
    p_organization_name: ORGANIZATION,
    p_company_name: STATION,
    p_timezone: 'America/Sao_Paulo',
  });
  const organizationId = provisioned.organization_id;
  const companyId = provisioned.company_id;

  // 3. A second Station, through the same RPC the console's AddStationForm
  // uses -- platform-admin only, which is why it runs on the admin session.
  await rpc(adminSession, 'add_company', {
    p_organization_id: organizationId,
    p_name: SECOND_STATION,
    p_timezone: 'America/Sao_Paulo',
  });

  // 4. The provisional password expires and the middleware forces a change
  // before any screen (src/middleware.ts). Cleared here so `npm run dev` opens
  // straight onto a full screen, which is the entire point of a demo seed.
  const cleared = await admin
    .from('profiles')
    .update({ must_change_password: false, provisional_expires_at: null })
    .eq('id', ownerUser);
  if (cleared.error) throw new Error(`clearing the provisional flag: ${cleared.error.message}`);

  const owner = await signIn(OWNER_EMAIL);

  // 5. A prize, and stock to draw from.
  const prize = await rpc(owner, 'create_prize', {
    p_company_id: companyId,
    p_name: 'Pair of tickets, Saturday show',
    p_allows_return_to_stock: true,
  });
  await rpc(owner, 'record_stock_entry', {
    p_company_id: companyId,
    p_prize_id: prize,
    p_type: 'INITIAL_ENTRY',
    p_quantity: 20,
    p_note: 'Demo seed',
  });

  // 6. A promotion running now, with part of that stock committed to it.
  const promotion = await rpc(owner, 'create_promotion', {
    p_company_id: companyId,
    p_name: 'Demo promotion - Saturday show',
    p_starts_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    p_ends_at: new Date(Date.now() + 21 * 86_400_000).toISOString(),
    p_call_to_action: 'Send your name to take part',
  });
  await rpc(owner, 'link_prize_to_promotion', {
    p_promotion_id: promotion,
    p_prize_id: prize,
    p_quantity: 5,
  });

  // 7. Listeners and their entries -- enough that a list looks like a list.
  const names = [
    'Ana Beatriz Ferreira',
    'Carlos Eduardo Lima',
    'Debora Nunes',
    'Eduardo Prado',
    'Fernanda Rocha',
    'Gustavo Aparecido',
    'Helena Castro',
    'Igor Menezes',
    'Juliana Assis',
    'Kleber Tavares',
  ];
  for (const [index, fullName] of names.entries()) {
    const memberId = await rpc(owner, 'create_member', {
      p_company_id: companyId,
      p_full_name: fullName,
      p_phone: `+5511${String(980000000 + index)}`,
    });
    await rpc(owner, 'record_participation', {
      p_promotion_id: promotion,
      p_member_id: memberId,
      p_participated_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
      p_source: 'MANUAL',
    });
  }

  // 8. A draw that has already run, so the screens open on an outcome rather
  // than on an empty state.
  await rpc(owner, 'run_draw', { p_promotion_id: promotion });

  await summarise(organizationId);
  printSignIn();
}

async function createUser(email, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message ?? 'no user'}`);

  // provision_customer expects the profile to exist already, exactly as
  // src/services/provisioning.ts writes it before calling.
  const profile = await admin
    .from('profiles')
    .insert({ id: data.user.id, email, full_name: fullName });
  if (profile.error) throw new Error(`profile for ${email}: ${profile.error.message}`);

  return data.user.id;
}

async function signIn(email) {
  const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** Calls an RPC and fails loudly rather than returning undefined into the next step. */
async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/**
 * A finished seed has both Stations and listeners in the first one. Checking the
 * LAST thing a run writes rather than the first is what makes this an honest
 * question: anything less means the run stopped somewhere in the middle.
 */
async function isComplete(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id')
    .eq('organization_id', organizationId);
  if ((companies.data ?? []).length < 2) return false;

  return (await countListeners((companies.data ?? []).map((c) => c.id))) > 0;
}

/**
 * Through member_company_links, because a Member belongs to the ORGANIZATION and
 * is linked to Stations (Block 3, the shared-listener design H3) -- `members` has
 * no company_id at all.
 *
 * The error is checked rather than ignored, and that is not ceremony: the first
 * version of this filtered `members.company_id`, which does not exist, and
 * PostgREST answered with an error that a `?? 0` turned into a summary reading
 * "0 listener(s)" over ten rows that were sitting right there.
 */
async function countListeners(companyIds) {
  const { count, error } = await admin
    .from('member_company_links')
    .select('member_id', { count: 'exact', head: true })
    .in('company_id', companyIds);
  if (error) throw new Error(`counting listeners: ${error.message}`);
  return count ?? 0;
}

async function summarise(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id, name')
    .eq('organization_id', organizationId)
    .order('name');

  for (const company of companies.data ?? []) {
    const listeners = await countListeners([company.id]);
    const { count: promotions, error } = await admin
      .from('promotions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company.id);
    if (error) throw new Error(`counting promotions: ${error.message}`);
    console.log(`  ${company.name}: ${listeners} listener(s), ${promotions ?? 0} promotion(s)`);
  }
}

function printSignIn() {
  console.log(`\n  the product: http://localhost:3000/login  ${OWNER_EMAIL} / ${PASSWORD}`);
  console.log(`  the console: http://localhost:3000/admin    ${ADMIN_EMAIL} / ${PASSWORD}`);
}

main().catch((cause) => {
  console.error(`\nseed:demo failed - ${cause.message}`);
  process.exit(1);
});
