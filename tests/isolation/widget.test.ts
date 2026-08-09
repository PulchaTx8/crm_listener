import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePublicKey, hashCode } from '@/lib/widget/code';
import {
  admin,
  cleanupUsers,
  provisionCustomer,
  readVerificationAttempts,
  seedIntegration,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 17a, Task 12. The two properties of the widget's doors that NO OTHER
 * HARNESS IN THIS REPOSITORY CAN SHOW.
 *
 * 1. THE TENANT BOUNDARY. A code minted at one Station is refused at another,
 *    and the other Station gains no listener, no link and no consent from the
 *    attempt. Both doors run as service_role, exactly as the server action does
 *    -- `admin` here bypasses RLS, so nothing in these results comes from a row
 *    policy. They come from widget_request_code and widget_verify_code
 *    resolving the installation from the PUBLIC KEY themselves and scoping the
 *    verification row to it. This is api-intake.test.ts's argument for the
 *    Block 15 credential, applied to the one other door in this product whose
 *    subject is not an auth.uid().
 *
 * 2. THE ATTEMPT CEILING UNDER REAL CONCURRENCY, which is a stronger claim than
 *    "five wrong guesses are refused" and the one 0161's `for update` exists
 *    for. See the second describe below for why pgTAP structurally cannot ask
 *    this question and this suite can.
 *
 * NO DEPENDENCE ON THE DEMO DATASET. Both Stations, both integrations, both
 * templates and both installations are built here, through the real doors, and
 * the auth users behind them are torn down afterwards. A test that read
 * scripts/seed-demo.mjs's Stations would break the day somebody changed the
 * demo, with nothing in that diff to explain why.
 */
const STAMP = Date.now();

/** Distinct per Station, so a refusal can never be a collision between fixtures. */
const PHONE_A = `+5511${String(STAMP).slice(-9)}`;
const PHONE_B = `+5521${String(STAMP).slice(-9)}`;
const PHONE_CEILING = `+5531${String(STAMP).slice(-9)}`;

/** What the visitor was sent, and one that is not it. */
const GOOD_CODE = '424242';
const WRONG_CODE = '000000';

/**
 * generatePublicKey and hashCode are IMPORTED from src, unlike
 * tests/e2e/widget.spec.ts, which reproduces the key shape by hand. The
 * difference is not taste: src/lib/widget/code.ts is `import 'server-only'`,
 * which vitest aliases to a stub (vitest.isolation.config.ts) and Playwright
 * does not — so importing it there would throw before the first test ran. Here
 * the real functions are used, which also means this file exercises the same
 * digest the server action sends.
 */
type WidgetStation = {
  customer: ProvisionedCustomer;
  publicKey: string;
};

type DoorAnswer = {
  ok?: unknown;
  reason?: unknown;
  member_id?: unknown;
  company_id?: unknown;
};

/** 0161's doors answer jsonb, which reaches supabase-js as `Json`. */
const answerOf = (data: unknown): DoorAnswer => data as DoorAnswer;

/**
 * A Station whose widget can actually send a code: an installation, a live
 * WhatsApp integration and a WEB_VERIFICATION template. Without all three
 * widget_request_code refuses with `no_integration` or `no_template` (0161) --
 * which would make every refusal below true for the wrong reason, and would be
 * the exact failure mode this file exists to tell apart.
 *
 * Every row goes in through the door a human would use: register_message_template
 * as the owner (has_permission's owner bypass makes this pure fixture setup, the
 * createPrizeAs convention), upsert_widget_installation as the platform admin it
 * is gated on. The integration is the one exception and it has no door at all --
 * see seedIntegration's own comment for why a direct connection to Postgres is
 * the only route left for that table.
 */
async function seedWidgetStation(label: string): Promise<WidgetStation> {
  const customer = await provisionCustomer(label);
  await seedIntegration(customer, `widget-${label}`);

  const owner = await signInAs(customer.email, customer.password);
  // ONE placeholder, because widget_request_code passes exactly one variable
  // (the six digits) and enqueue_whatsapp_outbound (0111) refuses a count that
  // does not match the body.
  const { error: templateError } = await owner.rpc('register_message_template', {
    p_company_id: customer.companyId,
    p_purpose: 'WEB_VERIFICATION',
    p_name: `web_verification_${label}`,
    p_language: 'pt_BR',
    p_body: 'Seu código é {{1}}.',
    p_variables: ['o código de seis dígitos'],
  });
  if (templateError) throw new Error(`register_message_template failed: ${templateError.message}`);

  const publicKey = generatePublicKey();
  const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
    p_company_id: customer.companyId,
    p_public_key: publicKey,
    p_enabled: true,
    p_allowed_origins: ['https://radio.example'],
  });
  if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);

  return { customer, publicKey };
}

describe('Block 17a — the widget across Stations', () => {
  let alpha: WidgetStation;
  let beta: WidgetStation;

  beforeAll(async () => {
    alpha = await seedWidgetStation(`widget-alpha-${STAMP}`);
    beta = await seedWidgetStation(`widget-beta-${STAMP}`);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it('mints a code at one Station', async () => {
    const { data, error } = await admin.rpc('widget_request_code', {
      p_public_key: alpha.publicKey,
      p_phone: PHONE_A,
      p_code_hash: hashCode(GOOD_CODE),
      p_code_plain: GOOD_CODE,
    });

    expect(error).toBeNull();
    expect(answerOf(data).ok, 'the first Station can send a code at all').toBe(true);
  });

  it('and the OTHER Station can too, so nothing below is a misconfiguration', async () => {
    // THE CONTROL CASE, and without it every refusal in this file would also be
    // the answer for a Station with no integration or no template. This proves
    // beta's door is live and its own codes work, so the refusal in the next
    // case is about WHOSE code it is and nothing else.
    const { data, error } = await admin.rpc('widget_request_code', {
      p_public_key: beta.publicKey,
      p_phone: PHONE_B,
      p_code_hash: hashCode(GOOD_CODE),
      p_code_plain: GOOD_CODE,
    });

    expect(error).toBeNull();
    expect(answerOf(data).ok, 'the second Station can send a code of its own').toBe(true);
  });

  it("refuses the first Station's code when it is presented to the second", async () => {
    // The fault this models is a bug in OUR OWN code, not a hostile visitor: the
    // page carries the public key out of its URL and the action passes it on, so
    // a mismatch means the wrong key reached the door. The door resolves the
    // verification from the installation that key names and finds nothing —
    // rather than matching on the telephone number alone, which is the shape
    // that would silently let one Station's code identify a listener at another.
    const { data, error } = await admin.rpc('widget_verify_code', {
      p_public_key: beta.publicKey,
      p_phone: PHONE_A,
      p_code_hash: hashCode(GOOD_CODE),
      p_name: 'Trespassing Listener',
    });

    expect(error).toBeNull();
    expect(answerOf(data).ok).toBe(false);
    expect(answerOf(data).reason).toBe('no_pending_code');
  });

  it('leaves the second Station with no listener, no link and no consent', async () => {
    // Not just "no member": the three tables are the three writes step 8, 9 and
    // 10 of widget_verify_code make, and a door that refused halfway would leave
    // exactly one or two of them behind — rows nothing would ever point at or
    // explain. Members are Organization-scoped (0031), so the listener count is
    // asked of the Organization and the other two of the Station.
    const members = await admin
      .from('members')
      .select('id')
      .eq('organization_id', beta.customer.organizationId);
    expect(members.data, 'listeners in the other Organization').toHaveLength(0);

    const links = await admin
      .from('member_company_links')
      .select('member_id')
      .eq('company_id', beta.customer.companyId);
    expect(links.data, 'audience links in the other Station').toHaveLength(0);

    const consents = await admin
      .from('member_consents')
      .select('id')
      .eq('company_id', beta.customer.companyId);
    expect(consents.data, 'consents in the other Station').toHaveLength(0);
  });

  it('spends the same code at its own Station, which is what makes the refusal mean anything', async () => {
    // THE CASE THAT KEEPS THE ONE ABOVE HONEST. A refusal proves nothing about
    // the tenant boundary if the code was simply wrong: this spends the very
    // same six digits at the Station that issued them and gets a listener, so
    // the only difference between the two calls is the public key.
    const { data, error } = await admin.rpc('widget_verify_code', {
      p_public_key: alpha.publicKey,
      p_phone: PHONE_A,
      p_code_hash: hashCode(GOOD_CODE),
      p_name: 'Isolation Listener',
    });

    expect(error).toBeNull();
    expect(answerOf(data).ok).toBe(true);
    expect(answerOf(data).member_id).toEqual(expect.any(String));
    expect(answerOf(data).company_id).toBe(alpha.customer.companyId);

    // THE ONE NON-ZERO MEMBER COUNT IN THIS FILE, and it is what makes the two
    // zeroes above and below mean anything. `members` is asserted empty for the
    // other Organization twice and was never asserted non-empty anywhere, so a
    // listener written with the WRONG organization_id -- or a query filtering
    // on a column that had been renamed -- would have satisfied both zeroes
    // while the tenant boundary was wide open. Asked of the Organization
    // because that is where members are scoped (0031), the same scope the
    // refusal case asks about.
    const identified = await admin
      .from('members')
      .select('id')
      .eq('organization_id', alpha.customer.organizationId);
    expect(identified.data, 'the listener landed in the Organization that identified them')
      .toHaveLength(1);

    const links = await admin
      .from('member_company_links')
      .select('member_id')
      .eq('company_id', alpha.customer.companyId);
    expect(links.data, 'the listener is linked to the Station that identified them').toHaveLength(1);

    const consents = await admin
      .from('member_consents')
      .select('id, origin, consent_type')
      .eq('company_id', alpha.customer.companyId);
    expect(consents.data).toHaveLength(1);
    expect(consents.data?.[0]?.origin).toBe('web-widget');
    expect(consents.data?.[0]?.consent_type).toBe('identification');

    // And the other Station still holds nothing, after the write that succeeded
    // as well as after the one that was refused.
    const strangers = await admin
      .from('member_company_links')
      .select('member_id')
      .eq('company_id', beta.customer.companyId);
    expect(strangers.data, 'the other Station gained nothing from the successful write').toHaveLength(0);
  });
});

/**
 * THE ATTEMPT CEILING, UNDER CONCURRENCY THAT IS REAL RATHER THAN IMAGINED.
 *
 * 0161's widget_verify_code takes the verification row `for update` so that the
 * read, the ceiling check and the increment serialise. The design spec (§6.1)
 * says in writing that "what protects a six-digit code is not the clock: it is
 * the ceiling of five attempts and the ten-minute expiry" — and that sentence is
 * only true against a SEQUENCE of attempts. Without the lock, N callers that
 * arrive together all run their own select before any of them reaches the
 * update, all read the SAME pre-increment `attempts`, and all N get a guess: a
 * ceiling of five per connection, which against a script is no ceiling at all.
 *
 * pgTAP STRUCTURALLY CANNOT ASK THIS. `supabase test db` runs each file as ONE
 * session inside one begin/rollback, so the lock can never contend with itself
 * and the clause is invisible whether it is present or absent —
 * supabase/tests/40_widget_verification.test.sql spends five sequential guesses
 * and passes identically either way. This suite talks to the database over the
 * network and can hold ten connections at once, which is the whole reason this
 * case lives here.
 *
 * PROVED TO BE ABLE TO FAIL. With `for update` deleted from 0161 and the
 * database reset, this case reports 10 wrong-code answers and `attempts` at 10;
 * with it restored, 5 and 5. Both runs are in the task report. A concurrency
 * test that passes with the lock removed is testing nothing.
 */
describe('Block 17a — the attempt ceiling when ten guesses arrive at once', () => {
  let station: WidgetStation;

  beforeAll(async () => {
    station = await seedWidgetStation(`widget-ceiling-${STAMP}`);

    const { data, error } = await admin.rpc('widget_request_code', {
      p_public_key: station.publicKey,
      p_phone: PHONE_CEILING,
      p_code_hash: hashCode(GOOD_CODE),
      p_code_plain: GOOD_CODE,
    });
    if (error) throw new Error(`widget_request_code failed: ${error.message}`);
    if (answerOf(data).ok !== true) {
      throw new Error(`widget_request_code refused the fixture: ${String(answerOf(data).reason)}`);
    }
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it('grants five guesses in total rather than five per connection', async () => {
    // THE SOCKETS ARE OPENED FIRST, AND THAT IS NOT A TIDINESS STEP — it is what
    // makes the race real. Node's fetch pool opens a connection per in-flight
    // request lazily, so ten calls made from a cold pool arrive staggered by
    // their own TCP handshakes: MEASURED, with `for update` deleted from 0161,
    // that produced 6 wrong-code answers where a fully simultaneous ten
    // produces 10. Six still fails this case, but a margin of one over the
    // ceiling is a proof that could agree by luck on a slower machine, which is
    // the same objection tests/isolation/conversation.test.ts's twelve rounds
    // answer for its own lock. These ten calls name a key no installation has,
    // so each is refused before it touches any row — all they leave behind is
    // ten warm, idle connections for the ten below to dispatch on at once.
    const unknownKey = generatePublicKey();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.rpc('widget_verify_code', {
          p_public_key: unknownKey,
          p_phone: PHONE_CEILING,
          p_code_hash: hashCode(WRONG_CODE),
        }),
      ),
    );

    // TEN AT ONCE, THROUGH PostgREST, which is what the server action reaches
    // the door through — ten separate HTTP requests, therefore ten separate
    // transactions on ten separate connections, therefore a genuine race. Fired
    // with Promise.all rather than awaited in sequence, because a sequence is
    // exactly the case that already passes without the lock.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.rpc('widget_verify_code', {
          p_public_key: station.publicKey,
          p_phone: PHONE_CEILING,
          p_code_hash: hashCode(WRONG_CODE),
        }),
      ),
    );

    for (const attempt of attempts) expect(attempt.error).toBeNull();
    const reasons = attempts.map((attempt) => answerOf(attempt.data).reason);

    // The tally is the assertion, not merely the stored counter: what the door
    // ANSWERED is what an attacker learns, and five 'wrong_code' answers means
    // five guesses were spent against the code. The other five were turned away
    // before the hash was ever compared (0161 step 4 before step 5).
    expect(
      reasons.filter((reason) => reason === 'wrong_code'),
      'exactly five of the ten concurrent guesses were allowed to be guesses',
    ).toHaveLength(5);
    expect(
      reasons.filter((reason) => reason === 'too_many_attempts'),
      'and the other five were refused by the ceiling',
    ).toHaveLength(5);

    // The row itself, read on the superuser connection because service_role
    // holds no grant on this table (see readVerificationAttempts). Five, not
    // ten: an increment per concurrent caller is what the missing lock looks
    // like from here.
    expect(await readVerificationAttempts(station.publicKey, PHONE_CEILING)).toBe(5);
  }, 60_000);

  it('refuses the RIGHT code once the ceiling has been spent', async () => {
    // The half of the ceiling that only matters because the check is BEFORE the
    // hash comparison. A burned row that could still be unlocked by finally
    // guessing right on the eleventh try was never bounded at five at all — and
    // this is the assertion that stays true only while 0161 keeps step 4 ahead
    // of step 5.
    const { data, error } = await admin.rpc('widget_verify_code', {
      p_public_key: station.publicKey,
      p_phone: PHONE_CEILING,
      p_code_hash: hashCode(GOOD_CODE),
      p_name: 'Persistent Guesser',
    });

    expect(error).toBeNull();
    expect(answerOf(data).ok).toBe(false);
    expect(answerOf(data).reason).toBe('too_many_attempts');

    const members = await admin
      .from('members')
      .select('id')
      .eq('organization_id', station.customer.organizationId);
    expect(members.data, 'and nobody was identified by any of the eleven attempts').toHaveLength(0);
  });
});
