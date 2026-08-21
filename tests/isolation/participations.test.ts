import { afterAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeCursor } from '@/lib/keyset';
import {
  PARTICIPATION_PAGE_SIZE,
  countPromotionParticipations,
  getParticipationAnswers,
  listParticipationsPage,
  searchStationListeners,
} from '@/services/participations';
import type { Database } from '@/lib/supabase/database.types';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clientFor(user: { email: string; password: string }) {
  return signInAs(user.email, user.password);
}

async function tokenFor(user: { email: string; password: string }): Promise<string> {
  const client = await clientFor(user);
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error(`could not read an access token: ${error?.message}`);
  return data.session.access_token;
}

/** A promotion on air now, registered by the owner. Fixture, never the operation under test. */
async function promotionAsOwner(
  customer: ProvisionedCustomer,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const owner = await clientFor(customer);
  const { data, error } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${Math.random().toString(36).slice(2, 8)}`,
    p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
    ...overrides,
  });
  if (error) throw new Error(`create_promotion failed: ${error.message}`);
  return data as string;
}

describe('recording a participation', () => {
  it('records a valid entry and returns the status', async () => {
    const label = `part-ok-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Um',
      phone: '11988887777',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const first = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'VALID' });

    const rows = await client
      .from('participations')
      .select('status, source, member_id')
      .eq('promotion_id', promotionId);
    expect(rows.data).toEqual([
      { status: 'VALID', source: 'MANUAL', member_id: memberId },
    ]);
  });

  it('records the second attempt as DUPLICATE rather than refusing it', async () => {
    const label = `part-dup-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Dois',
      phone: '11988887778',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    // `as const` on the source, the same way the concurrency case at the foot of
    // this file writes it: without it the literal widens to `string` and no
    // longer satisfies the generated participation_source union.
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL' as const, p_answers: [] };
    await client.rpc('record_participation', { ...entry, p_participated_at: new Date().toISOString() });
    const second = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });

    // Not an error. The attempt is recorded with the status that says what
    // happened to it, which is what Block 5's bot will need without a choice.
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ status: 'DUPLICATE' });

    // Ordered by the ENUM's declaration order, which is not alphabetical:
    // participation_status is declared VALID, DUPLICATE, TOO_SOON, OVER_LIMIT
    // (0052) and Postgres sorts an enum by that order, so ascending puts VALID
    // first. The brief expected [DUPLICATE, VALID] and this case went red on the
    // sort rather than on anything record_participation did — a case failing for
    // a reason its name does not give. Both rows and both statuses are still
    // pinned; only the order they come back in changed.
    const rows = await client
      .from('participations')
      .select('status')
      .eq('promotion_id', promotionId)
      .order('status');
    expect(rows.data).toEqual([{ status: 'VALID' }, { status: 'DUPLICATE' }]);
  });

  it('records TOO_SOON inside the interval and VALID after it', async () => {
    const label = `part-soon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Tres',
      phone: '11988887779',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    // `as const` on the source, the same way the concurrency case at the foot of
    // this file writes it: without it the literal widens to `string` and no
    // longer satisfies the generated participation_source union.
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL' as const, p_answers: [] };

    const first = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 10 * HOUR).toISOString(),
    });
    expect(first.data).toMatchObject({ status: 'VALID' });

    // Two hours after the first: inside the six-hour interval.
    const tooSoon = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 8 * HOUR).toISOString(),
    });
    expect(tooSoon.data).toMatchObject({ status: 'TOO_SOON' });

    // Ten hours after the first: outside it.
    const later = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base).toISOString(),
    });
    expect(later.data).toMatchObject({ status: 'VALID' });
  });

  /**
   * The same rule read BACKWARDS, which is the direction that shipped broken.
   *
   * Every interval case in this block — the one above, and the import's
   * "honours the timestamp in the file" case — walks forward in time, and that
   * is exactly why nothing caught it. `apply_participation`'s check was a lower
   * bound only (`participated_at > v_when - N hours`), so ANY existing VALID
   * entry later than that instant fired the branch, including one arbitrarily
   * far in the FUTURE of the row being written. Measured against this stack at
   * the time: first entry at 20:00, second at 08:00 the same day — twelve hours
   * EARLIER — came back TOO_SOON.
   *
   * It is silent and it costs somebody a prize: the row is not VALID, so Block
   * 6's draw leaves out a listener who was entitled to be in it, and the import
   * tells the operator N people came back too soon. And it is reachable through
   * this block's headline path, not by contrivance — import_participations
   * walks the file in row order, and a spreadsheet exported newest-first is an
   * ordinary spreadsheet.
   *
   * Three entries, and the middle one is what makes this a test of a WINDOW
   * rather than of a sign flip: an hour before the first is inside the interval
   * and must still be TOO_SOON. Assert only the twelve-hour case and a fix that
   * simply reversed the comparison would pass.
   */
  it('measures the interval symmetrically: an entry backdated past it counts, one inside it does not', async () => {
    const label = `part-back-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Retroativo',
      phone: '11988887783',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL' as const, p_answers: [] };

    // The anchor, written first and dated latest — the shape a newest-first
    // export produces on its very first line.
    const anchor = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base).toISOString(),
    });
    expect(anchor.data).toMatchObject({ status: 'VALID' });

    // One hour EARLIER than the anchor: inside the six-hour window on the
    // backward side, so still too soon. This is the assertion that stops the
    // fix from being "drop the bound".
    const justBefore = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - HOUR).toISOString(),
    });
    expect(justBefore.data).toMatchObject({ status: 'TOO_SOON' });

    // Twelve hours EARLIER: outside it, and the one that came back TOO_SOON
    // before the window had a second bound.
    const wellBefore = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 12 * HOUR).toISOString(),
    });
    expect(wellBefore.data).toMatchObject({ status: 'VALID' });
  });

  // Moved here from Task 3, which could not host it: the ceiling is only
  // settable through update_promotion's p_max_entries_per_member, an argument
  // that RPC did not have until 0055 dropped and recreated it. Written there it
  // could only sit red, and it could not be skipped either — the isolation guard
  // fails closed on a pending or todo test, so one .skip breaks the gate for
  // everybody after it. OVER_LIMIT is the one status with no coverage anywhere
  // else, which is why it came back rather than being dropped.
  it('records OVER_LIMIT once the ceiling is reached', async () => {
    const label = `part-limit-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Quatro',
      phone: '11988887770',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
    });

    // The ceiling has no other door. create_promotion does not take it (0042 is
    // merged history and 0055 only reopened the update side), so the fixture
    // registers the promotion and then edits it — which is also why this case
    // could not exist before the seventeen-argument signature did.
    const owner = await clientFor(customer);
    const ceiling = await owner.rpc('update_promotion', {
      p_promotion_id: promotionId,
      p_name: 'Com teto',
      p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
      p_max_entries_per_member: 2,
    });
    // Asserted rather than assumed. A ceiling that failed to land silently would
    // leave max_entries_per_member null, the third entry would be VALID, and the
    // case would go red naming the ceiling while the real fault was the edit —
    // which is exactly how it failed in Task 3 (PGRST202, the argument absent).
    expect(ceiling.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    // `as const` on the source, the same way the concurrency case at the foot of
    // this file writes it: without it the literal widens to `string` and no
    // longer satisfies the generated participation_source union.
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL' as const, p_answers: [] };

    // Two hours between each entry against a one-hour interval, so the third is
    // refused for the ceiling and not for coming in too early. Ceiling of 2,
    // three entries: VALID, VALID, OVER_LIMIT. Space them any tighter and the
    // interval fires first, the case passes on TOO_SOON's rule, and it says
    // nothing at all about the one it is named for.
    const a = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 5 * HOUR).toISOString(),
    });
    const b = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 3 * HOUR).toISOString(),
    });
    const c = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base).toISOString(),
    });

    expect(a.data).toMatchObject({ status: 'VALID' });
    expect(b.data).toMatchObject({ status: 'VALID' });
    expect(c.data).toMatchObject({ status: 'OVER_LIMIT' });
  });

  it('stores the answers, and stores them for a refused attempt too', async () => {
    const label = `part-answers-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Cinco',
      phone: '11988887771',
    });
    const promotionId = await promotionAsOwner(customer);

    const owner = await clientFor(customer);
    const { data: questionId } = await owner.rpc('save_promotion_question', {
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

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: options } = await client
      .from('promotion_question_options')
      .select('id, label')
      .eq('question_id', questionId as string);
    const brasil = options!.find((o) => o.label === 'Brasil')!.id;

    const entry = {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_source: 'MANUAL' as const,
      p_answers: [{ question_id: questionId, option_id: brasil }],
    };

    const first = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });
    expect(first.data).toMatchObject({ status: 'VALID' });

    const second = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });
    expect(second.data).toMatchObject({ status: 'DUPLICATE' });

    // Both attempts keep what the person said. The status says whether it
    // counted; the answer says what happened, and Block 5 will want the answer
    // of a duplicate message for exactly the same reason.
    const answers = await client
      .from('participation_answers')
      .select('participation_id, option_id')
      .eq('promotion_id', promotionId);
    expect(answers.data).toHaveLength(2);
    expect(answers.data!.every((a) => a.option_id === brasil)).toBe(true);
  });

  it('refuses an answer naming a question from another promotion, and writes nothing', async () => {
    const label = `part-foreign-q-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Nove',
      phone: '11988887776',
    });
    const promotionId = await promotionAsOwner(customer);
    const otherPromotionId = await promotionAsOwner(customer);

    const owner = await clientFor(customer);
    const { data: foreignQuestionId, error: questionError } = await owner.rpc(
      'save_promotion_question',
      {
        p_promotion_id: otherPromotionId,
        p_kind: 'QUIZ',
        p_prompt: 'Pergunta de outra promoção',
        p_menu_title: 'Escolha',
        p_button_label: 'Opções',
        p_options: [
          { label: 'Sim', is_correct: true },
          { label: 'Não', is_correct: false },
        ],
      },
    );
    if (questionError) throw new Error(`save_promotion_question failed: ${questionError.message}`);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: options } = await client
      .from('promotion_question_options')
      .select('id')
      .eq('question_id', foreignQuestionId as string);

    const denied = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [{ question_id: foreignQuestionId, option_id: options![0]!.id }],
    });

    // The sentence, not only the code, and the two are not interchangeable here.
    // Drop the `q.promotion_id = p_promotion_id` predicate from the answers loop
    // and this question is FOUND, the insert goes ahead, and
    // participation_answers_question_fk refuses it with 23503 and a constraint
    // name. A code-only assertion would go red on that mutation too, but for the
    // wrong reason and with nothing said about what the operator sees; this pins
    // the refusal an operator can act on.
    expect(denied.error?.code).toBe('P0002');
    expect(denied.error?.message).toBe(
      `question not found in this promotion: ${foreignQuestionId}`,
    );

    // And the attempt left nothing behind. The participation row is inserted
    // BEFORE the answers loop runs, so it survives only if the refusal fails to
    // roll the whole call back — which is the half of this that the error code
    // cannot say anything about.
    const rows = await client
      .from('participations')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(rows.data).toEqual([]);
  });

  it('refuses a cancelled promotion, one outside its window, and a listener from another Station', async () => {
    const label = `part-refuse-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Seis',
      phone: '11988887772',
    });
    const foreignMemberId = await createMemberAs(customer, otherCompanyId, {
      fullName: 'Ouvinte De Fora',
      phone: '11988887773',
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.cancel',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const cancelled = await promotionAsOwner(customer);
    await client.rpc('cancel_promotion', {
      p_promotion_id: cancelled,
      p_reason: 'sponsor pulled out',
    });
    const onCancelled = await client.rpc('record_participation', {
      p_promotion_id: cancelled,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(onCancelled.error?.code).toBe('22023');

    const scheduled = await promotionAsOwner(customer, {
      p_starts_at: new Date(Date.now() + 7 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    const beforeOpen = await client.rpc('record_participation', {
      p_promotion_id: scheduled,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(beforeOpen.error?.code).toBe('22023');

    const open = await promotionAsOwner(customer);
    const crossStation = await client.rpc('record_participation', {
      p_promotion_id: open,
      p_member_id: foreignMemberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(crossStation.error?.code).toBe('P0002');
  });

  it('refuses a promotion that is not there and one that has been archived', async () => {
    const label = `part-missing-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Dez',
      phone: '11988887781',
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.archive',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const missing = await client.rpc('record_participation', {
      p_promotion_id: '00000000-0000-0000-0000-0000000000ff',
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(missing.error?.code).toBe('P0002');

    // Archived rather than merely closed, and the two are different refusals.
    // archive_promotion (0042) will not touch a promotion that is still taking
    // entries, so this one has to have ended first — which is why its window is
    // in the past.
    const ended = await promotionAsOwner(customer, {
      p_starts_at: new Date(Date.now() - 3 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() - DAY).toISOString(),
    });
    const archived = await client.rpc('archive_promotion', { p_promotion_id: ended });
    expect(archived.error).toBeNull();

    // The timestamp is INSIDE that past window on purpose. An attempt stamped
    // `now` would be outside it, and the case would pass on the window guard
    // (22023) rather than on deleted_at — which is not what its name claims and
    // would survive deleting the `v_deleted is not null` half outright.
    const onArchived = await client.rpc('record_participation', {
      p_promotion_id: ended,
      p_member_id: memberId,
      p_participated_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(onArchived.error?.code).toBe('P0002');
  });

  it('refuses a delegate who may see participations but not record one', async () => {
    const label = `part-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Sete',
      phone: '11988887774',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
    ]);
    const client = await clientFor(delegate);

    const denied = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(denied.error?.code).toBe('42501');
  });

  // participations.import does not open the manual door, and p_source does not
  // decide which door a call came through. Both halves matter and neither is
  // covered by the case above, which grants no write code at all.
  //
  // The rules and the writes live in apply_participation, shared by both public
  // functions; the gate is in each of them, beside its own operation (0027). An
  // earlier draft had one function picking its permission code from p_source,
  // which meant a caller-supplied label chose which check it faced. The second
  // call below is what refuses that draft: with the gate back where it belongs,
  // claiming IMPORT on a hand-typed entry changes the column and nothing else.
  it('refuses a delegate holding participations.import at the manual door, whatever source the row claims', async () => {
    const label = `part-import-only-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Onze',
      phone: '11988887782',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
    ]);
    const client = await clientFor(delegate);

    const entry = {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_answers: [],
    };

    const byHand = await client.rpc('record_participation', { ...entry, p_source: 'MANUAL' });
    expect(byHand.error?.code).toBe('42501');
    expect(byHand.error?.message).toBe('permission denied: participations.create required');

    // The same refusal, and the same sentence, for a row that calls itself an
    // import. A gate that read p_source would let this one through.
    const mislabelled = await client.rpc('record_participation', { ...entry, p_source: 'IMPORT' });
    expect(mislabelled.error?.code).toBe('42501');
    expect(mislabelled.error?.message).toBe('permission denied: participations.create required');
  });

  /**
   * Twelve, and the number is arithmetic rather than taste.
   *
   * One round of this race is a WEAK detector of a missing lock. Measured, by
   * re-applying record_participation with the pg_advisory_xact_lock line removed
   * and nothing else changed: 7 red in 21 single-round runs, so it catches the
   * missing lock about one time in three and MISSES it two times in three. It is
   * not that the two calls fail to overlap — a probe with the lock removed and a
   * pg_sleep(2) between the decision and the insert failed every time, and took
   * one sleep's worth of wall time for two calls, so they do overlap. The window
   * a missing lock leaves open is simply sub-millisecond, and two HTTP requests
   * do not reliably interleave that finely.
   *
   * Rounds are independent, so twelve of them miss with probability
   * (2/3)^12 = 0.0077 — under one run in a hundred. Five would leave
   * (2/3)^5 = 0.13, one run in eight, which is not a net. The measured figure
   * after this change is in the report; if it ever drifts, re-measure and move
   * this number from the measurement, never the other way round.
   */
  const RACE_ROUNDS = 12;

  // This is the case N3 exists for, and the one the mutation in Task 10 targets.
  it('lets exactly one of two simultaneous entries be VALID', async () => {
    const label = `part-race-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    // A fresh listener per round, so each round is a fresh (promotion, member)
    // pair: the advisory lock is taken over exactly that pair, and reusing one
    // listener would make every round after the first trivially DUPLICATE
    // against the first round's committed row rather than a race at all.
    //
    // Registered through one owner client rather than through createMemberAs,
    // which signs in again on every call — the same reason the prize-picker cap
    // case in promotion-prizes.test.ts calls create_prize directly.
    const owner = await clientFor(customer);
    const members = await Promise.all(
      Array.from({ length: RACE_ROUNDS }, async (_, index) => {
        const { data, error } = await owner.rpc('create_member', {
          p_company_id: customer.companyId,
          p_full_name: `Ouvinte Oito ${index}`,
          p_phone: `1198888${String(7800 + index)}`,
        });
        if (error) throw new Error(`create_member failed: ${error.message}`);
        return data as string;
      }),
    );

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    // Two separate clients, so the two calls are two connections rather than
    // two statements queued on one.
    const a = await clientFor(delegate);
    const b = await clientFor(delegate);

    for (const memberId of members) {
      const entry = {
        p_promotion_id: promotionId,
        p_member_id: memberId,
        p_participated_at: new Date().toISOString(),
        p_source: 'MANUAL' as const,
        p_answers: [],
      };

      const [first, second] = await Promise.all([
        a.rpc('record_participation', entry),
        b.rpc('record_participation', entry),
      ]);

      expect(first.error).toBeNull();
      expect(second.error).toBeNull();

      // Exactly one VALID and exactly one DUPLICATE — asserted on the statuses
      // rather than on a count, because the partial unique index would also
      // produce "one row" by raising 23505 on the loser. The whole point of the
      // lock is that the loser is RECORDED as a duplicate rather than lost, and
      // only the status can tell those two outcomes apart.
      const statuses = [first.data, second.data]
        .map((d) => (d as { status: string }).status)
        .sort();
      expect(statuses).toEqual(['DUPLICATE', 'VALID']);
    }
  });
});

describe('importing a file', () => {
  it('records the good rows, marks the repeats, and skips the unusable ones', async () => {
    const label = `imp-mixed-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const when = new Date(Date.now() - HOUR).toISOString();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Ana Lima', phone: '11970000001', participated_at: when },
        { line: 3, full_name: 'Bruno Reis', phone: '11970000002', participated_at: when },
        // The same person again: recorded, and marked as the repeat it is.
        { line: 4, full_name: 'Ana Lima', phone: '11970000001', participated_at: when },
        // Nothing to identify her by.
        { line: 5, full_name: 'Carla Souza', participated_at: when },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      recorded: 3,
      duplicate: 1,
      skipped: 1,
      members_created: 2,
    });

    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.find((r) => r.line === 5)).toMatchObject({
      outcome: 'skipped',
      reason: 'no identifier',
    });
    expect(rows.find((r) => r.line === 4)).toMatchObject({
      outcome: 'recorded',
      status: 'DUPLICATE',
    });

    // Two listeners for three recorded rows: the repeat reused the first one.
    const members = await client.from('participations').select('member_id').eq('promotion_id', promotionId);
    expect(new Set(members.data!.map((m) => m.member_id)).size).toBe(2);
  });

  it('honours the timestamp in the file rather than the clock', async () => {
    const label = `imp-when-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Dora Melo', phone: '11970000003', participated_at: new Date(base - 30 * HOUR).toISOString() },
        { line: 3, full_name: 'Dora Melo', phone: '11970000003', participated_at: new Date(base - 20 * HOUR).toISOString() },
      ],
    });

    // Ten hours apart in the file, against a six-hour interval: both count.
    // Stamped "now" on both, the second would have been TOO_SOON — which is the
    // whole reason the column exists and the file carries it.
    expect(result.data).toMatchObject({ recorded: 2, too_soon: 0 });
  });

  it('skips a row whose identifier belongs to a listener this caller cannot reach', async () => {
    const label = `imp-elsewhere-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    // Registered in the other Station, so a delegate scoped to the first cannot
    // reach them — and 0031's unique index on the phone means they cannot be
    // registered a second time either.
    await createMemberAs(customer, otherCompanyId, {
      fullName: 'Fora do Alcance',
      phone: '11970000009',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Fora do Alcance', phone: '11970000009', participated_at: new Date().toISOString() },
      ],
    });

    expect(result.data).toMatchObject({ recorded: 0, skipped: 1 });
    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0]).toMatchObject({ outcome: 'skipped', reason: 'listener is out of reach' });
  });

  /**
   * The case that would have caught 0056's defect, and the assertion that
   * matters is the last one.
   *
   * Before 0056 this file did not skip a row — it destroyed itself.
   * resolve_or_create_member searches the whole Organization (Block 3's
   * deduplication, 0033), so a listener registered only at a sister Station
   * RESOLVES; apply_participation one line later requires the promotion's own
   * Station to be linked to them and raises P0002; that raise propagates out of
   * import_participations and rolls the transaction back. A three-hundred-row
   * file wrote nothing because of row 47, and the operator was told a promotion
   * or a listener could not be found.
   *
   * Note what this listener is NOT: they are not out of reach. The delegate
   * holds members.view across the Organization, so find_member_by_identifier
   * answers `visible` and hands back an id — which is precisely why the
   * `elsewhere` case above cannot stand in for this one, and why the reason has
   * to be its own. The fix is different too: this operator can link them.
   *
   * The two rows either side of the bad one are the point. Asserting only that
   * row 3 comes back skipped would pass against a function that skipped it and
   * then rolled back anyway, or against one that never wrote rows 2 and 4 —
   * which is the failure being fixed. The `participations` read at the end is
   * the only assertion that can see it.
   */
  it('skips a listener registered only at a sister Station, and leaves the rest of the file written', async () => {
    const label = `imp-unlinked-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const promotionId = await promotionAsOwner(customer);

    // Registered at the OTHER Station only. Reachable — the delegate's role
    // below is granted at both Stations, so members.view resolves them — but not
    // linked to the Station the promotion belongs to.
    await createMemberAs(customer, otherCompanyId, {
      fullName: 'Vizinho De Outra Praca',
      phone: '11970000010',
    });

    const delegate = await grantRoleWith(
      customer,
      label,
      [
        'promotions.view',
        'participations.view',
        'participations.import',
        'members.view',
        'members.create',
      ],
      // Both Stations, which is what separates this case from the `elsewhere`
      // one above: there the delegate could not see the listener at all, here
      // they can see them perfectly and still cannot enter them.
      [customer.companyId, otherCompanyId],
    );
    const client = await clientFor(delegate);

    const when = new Date(Date.now() - HOUR).toISOString();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Antes Da Falha', phone: '11970000011', participated_at: when },
        { line: 3, full_name: 'Vizinho De Outra Praca', phone: '11970000010', participated_at: when },
        { line: 4, full_name: 'Depois Da Falha', phone: '11970000012', participated_at: when },
      ],
    });

    // Not an error at all, which is the first half of the fix: before 0056 this
    // came back P0002 with `data` null.
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      recorded: 2,
      skipped: 1,
      members_created: 2,
    });

    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    // The reason is asserted as a STRING and not merely as "skipped", because
    // the screen turns each of the three into a different instruction. Answering
    // this one with 'listener is out of reach' would send an operator who holds
    // members.view here to go and ask for members.view.
    expect(rows.find((r) => r.line === 3)).toMatchObject({
      outcome: 'skipped',
      reason: 'listener is at another station',
    });
    expect(rows.find((r) => r.line === 2)).toMatchObject({
      outcome: 'recorded',
      status: 'VALID',
    });
    expect(rows.find((r) => r.line === 4)).toMatchObject({
      outcome: 'recorded',
      status: 'VALID',
    });

    // THE assertion. Everything above describes what the function SAID; this is
    // what it did. A transaction that rolled back would report the same summary
    // only if it never returned at all — but a future "fix" that caught the raise
    // per row and let the transaction die at commit would satisfy every line
    // above and leave this table empty.
    const written = await client
      .from('participations')
      .select('member_id')
      .eq('promotion_id', promotionId);
    expect(written.error).toBeNull();
    expect(written.data).toHaveLength(2);

    // And the skipped listener has no entry in this promotion — the row was not
    // quietly recorded against a Station that is not linked to them.
    const neighbour = await client
      .from('members')
      .select('id')
      .eq('phone_normalized', '11970000010')
      .single();
    expect(neighbour.error).toBeNull();
    expect(written.data!.map((r) => r.member_id)).not.toContain(neighbour.data!.id);
  });

  /**
   * The second spelling of the defect 0056 was written to remove, and it had
   * survived every gate.
   *
   * apply_participation refuses a row outside the promotion's window with 22023
   * (0054), and the loop has no begin/exception around the call — so before
   * this fix ONE such row rolled the whole transaction back and a
   * three-hundred-row file wrote nothing. 0056's own header states the
   * principle it was closing ("a three-hundred-row file writes NOTHING because
   * of row 47") and closed only the unlinked-listener half of it.
   *
   * Not a contrived input: `importRowSchema` validates only that the instant
   * parses, and the import form is never given the promotion's starts_at or
   * ends_at, so nothing in front of the operator can warn them. A file of last
   * month's entries pointed at this month's promotion is D7's own scenario with
   * the wrong promotion picked in the dialog.
   *
   * Both edges, because the predicate is asymmetric on purpose (`< starts` and
   * `>= ends`, apply_participation's own): a row before the promotion opened
   * and a row after it closed are one rule, and covering only the opening edge
   * would leave `>=` free to become `>` unnoticed.
   *
   * The last assertion is the one that matters, exactly as in the sister case
   * above: everything before it describes what the function SAID, and a
   * transaction that skipped the bad rows and then died at commit would satisfy
   * all of it.
   */
  it('skips a row dated outside the promotion window at either edge, and leaves the rest of the file written', async () => {
    const label = `imp-window-${Date.now()}`;
    const customer = await provisionCustomer(label);
    // The window is named here rather than taken from the default, because
    // every row below is positioned against these two instants.
    const starts = new Date(Date.now() - 2 * DAY).toISOString();
    const ends = new Date(Date.now() + 2 * DAY).toISOString();
    const promotionId = await promotionAsOwner(customer, {
      p_starts_at: starts,
      p_ends_at: ends,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const inside = new Date(Date.now() - HOUR).toISOString();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Dentro Da Janela', phone: '11970000021', participated_at: inside },
        // Before it opened.
        { line: 3, full_name: 'Cedo Demais', phone: '11970000022', participated_at: new Date(Date.now() - 10 * DAY).toISOString() },
        // Exactly ON ends_at, which the predicate treats as closed (`>= ends`).
        { line: 4, full_name: 'No Fechamento', phone: '11970000023', participated_at: ends },
        { line: 5, full_name: 'Tambem Dentro', phone: '11970000024', participated_at: inside },
      ],
    });

    // Not an error at all, which is the first half of the fix: before it, this
    // came back 22023 with `data` null and nothing written.
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ recorded: 2, skipped: 2 });

    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    // The reason as a STRING, not merely "skipped": the screen turns each of
    // the four into a different instruction, and answering this one with
    // 'listener is out of reach' would send the operator to ask for access they
    // already hold over a date they could have fixed themselves.
    expect(rows.find((r) => r.line === 3)).toMatchObject({
      outcome: 'skipped',
      reason: 'outside the promotion window',
    });
    expect(rows.find((r) => r.line === 4)).toMatchObject({
      outcome: 'skipped',
      reason: 'outside the promotion window',
    });
    expect(rows.find((r) => r.line === 2)).toMatchObject({ outcome: 'recorded', status: 'VALID' });
    expect(rows.find((r) => r.line === 5)).toMatchObject({ outcome: 'recorded', status: 'VALID' });

    // Nobody was registered for a line that could never be entered: the window
    // check sits BEFORE resolve_or_create_member precisely so a skipped row
    // does not leave a listener behind it.
    expect(result.data).toMatchObject({ members_created: 2 });

    // THE assertion. What it did, rather than what it said.
    const written = await client
      .from('participations')
      .select('member_id')
      .eq('promotion_id', promotionId);
    expect(written.error).toBeNull();
    expect(written.data).toHaveLength(2);
  });

  it('refuses a delegate holding participations.import but not members.create', async () => {
    const label = `imp-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    // Import registers listeners. Without members.create this would be a side
    // door that registers people for somebody who may not register one.
    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
    ]);
    const client = await clientFor(delegate);

    const denied = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Nova Pessoa', phone: '11970000004', participated_at: new Date().toISOString() },
      ],
    });
    // The message, not only the code, and here the two are not interchangeable.
    // Delete the members.create gate from import_participations outright and
    // this call STILL comes back 42501 — create_member has its own gate and
    // row 2 would trip it — so a code-only assertion would stay green while the
    // thing this case is named for, refusing the file before a single row is
    // written rather than halfway through it, was gone. Only the sentence tells
    // the two apart, the same reasoning the foreign-question case above gives.
    expect(denied.error?.code).toBe('42501');
    expect(denied.error?.message).toBe(
      'permission denied: members.create required to import participations',
    );
  });
});

describe("Block 4a's freeze, now that there is something to freeze", () => {
  it('locks the hashtag and the start date once somebody has entered, and leaves the rest open', async () => {
    const label = `freeze-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Nove',
      phone: '11970000005',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_whatsapp_enabled: true,
      p_hashtag: '#EUQUERO',
      // Block 30c D2 (0259): create_promotion now refuses a WhatsApp- or
      // web-enabled promotion with blank rules. Carried on `base` below too,
      // for the same reason update_promotion's own wholesale replace needs it
      // repeated on every one of its calls — the freeze this test proves is
      // otherwise indistinguishable, by sqlstate alone, from the rules gate.
      p_rules: `Freeze rules ${label}`,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const starts = new Date(Date.now() - 2 * DAY).toISOString();
    const ends = new Date(Date.now() + 20 * DAY).toISOString();
    const base = {
      p_promotion_id: promotionId,
      p_starts_at: starts,
      p_ends_at: ends,
      p_whatsapp_enabled: true,
      p_hashtag: '#EUQUERO',
      // update_promotion replaces every field wholesale, so leaving this out
      // would clear the rules on the FIRST call below and trip D2's gate
      // rather than the freeze this test is about.
      p_rules: `Freeze rules ${label}`,
    };

    // Before anybody enters, the hashtag moves freely.
    const beforeAnyone = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#OUTRO',
    });
    expect(beforeAnyone.error).toBeNull();

    // Asserted, not assumed. If this fixture failed, no participation would
    // exist, every edit below would legitimately succeed, and the two refusal
    // assertions would go red reading `expected undefined to be '22023'` —
    // pointing at the guard when the fault was the fixture. Same reasoning as
    // the ceiling case above.
    const entered = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(entered.error).toBeNull();
    expect(entered.data).toMatchObject({ status: 'VALID' });

    const hashtagNow = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#MUDOU',
    });
    expect(hashtagNow.error?.code).toBe('22023');

    const startNow = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#OUTRO',
      p_starts_at: new Date(Date.now() - 3 * DAY).toISOString(),
    });
    expect(startNow.error?.code).toBe('22023');

    // What stays open: the name, the end date, the call to action, the art and
    // the button labels. Listeners are already texting the hashtag; nobody is
    // reading the name.
    const newEnds = new Date(Date.now() + 40 * DAY).toISOString();
    const stillOpen = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Nome novo',
      p_hashtag: '#OUTRO',
      p_ends_at: newEnds,
      p_call_to_action: 'Manda #OUTRO agora',
    });
    expect(stillOpen.error).toBeNull();

    // Read back, because `error is null` is not the claim this case makes. A
    // freeze written as an early `return` rather than a `raise` would raise
    // nothing, write nothing, and pass the assertion above — the edit would be
    // silently discarded and the operator told it had landed. Only the row can
    // tell "allowed" apart from "swallowed".
    const after = await client
      .from('promotions')
      .select('name, ends_at, call_to_action, hashtag')
      .eq('id', promotionId)
      .single();
    expect(after.error).toBeNull();
    expect(after.data?.name).toBe('Nome novo');
    expect(after.data?.call_to_action).toBe('Manda #OUTRO agora');
    // Normalised through Date on both sides: Postgres renders timestamptz as
    // `+00:00` where toISOString renders `Z`, so the strings differ while the
    // instants do not.
    expect(new Date(after.data!.ends_at).toISOString()).toBe(newEnds);
    // And the frozen field is still what it was, which is the other half of
    // "the refusals refused" — a guard that raised but wrote anyway would show
    // up here and nowhere else.
    expect(after.data?.hashtag).toBe('#OUTRO');
  });

  it('refuses to remove a question once somebody has entered', async () => {
    const label = `freeze-q-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Dez',
      phone: '11970000006',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: questionId } = await client.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'Por que você ouve?',
      p_options: [],
    });

    // Removable while nothing points at it — which is what 0041's table comment
    // says is the only time it is ever removable.
    const before = await client.rpc('remove_promotion_question', {
      p_question_id: questionId as string,
    });
    expect(before.error).toBeNull();

    const { data: second } = await client.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'E agora?',
      p_options: [],
    });
    // Asserted for the same reason as the case above: a fixture that failed
    // here would leave the removal legitimately permitted, and the assertion
    // below would blame the guard.
    const entered = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(entered.error).toBeNull();
    expect(entered.data).toMatchObject({ status: 'VALID' });

    const after = await client.rpc('remove_promotion_question', {
      p_question_id: second as string,
    });
    expect(after.error?.code).toBe('22023');
  });

  // D9's third surface. remove_promotion_question is not the only way to change
  // what the audience was shown: save_promotion_question with a non-null
  // p_question_id REPLACES the question and its options wholesale, so without a
  // guard an operator could reword an option — or move the right answer onto a
  // different one — under answers already given. 0052's table comment stakes
  // Block 6's draw-time correctness on that being impossible.
  it("freezes a question's wording once somebody has entered, and still lets a new one be added", async () => {
    const label = `freeze-edit-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Onze',
      phone: '11970000007',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    // menu_title and button_label are not decoration: 0041's
    // promotion_questions_list_fields requires both on anything that is not an
    // ESSAY, and omitting them fails the fixture with 23514 rather than testing
    // anything about the freeze.
    const quiz = {
      p_promotion_id: promotionId,
      p_kind: 'QUIZ' as const,
      p_prompt: 'Quem ganha a Copa?',
      p_menu_title: 'Escolha',
      p_button_label: 'Opções',
      p_options: [
        { label: 'Brasil', is_correct: true },
        { label: 'Argentina', is_correct: false },
      ],
    };
    const created = await client.rpc('save_promotion_question', quiz);
    expect(created.error).toBeNull();
    const questionId = created.data as string;

    // Before anybody enters, the wording moves freely — including which option
    // is the right one, which is the edit that matters most.
    const editBefore = await client.rpc('save_promotion_question', {
      ...quiz,
      p_question_id: questionId,
      p_options: [
        { label: 'Brasil', is_correct: false },
        { label: 'Argentina', is_correct: true },
      ],
    });
    expect(editBefore.error).toBeNull();

    const entered = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(entered.error).toBeNull();
    expect(entered.data).toMatchObject({ status: 'VALID' });

    // Now the same edit is refused.
    const editAfter = await client.rpc('save_promotion_question', {
      ...quiz,
      p_question_id: questionId,
      p_prompt: 'Quem ganha mesmo?',
    });
    expect(editAfter.error?.code).toBe('22023');

    // And the option nobody may reword still says what it said. The refusal
    // deletes the options before rewriting them, so a guard placed after that
    // delete would raise and still have destroyed them.
    const options = await client
      .from('promotion_question_options')
      .select('label, is_correct')
      .eq('question_id', questionId)
      .order('position');
    expect(options.data).toEqual([
      { label: 'Brasil', is_correct: false },
      { label: 'Argentina', is_correct: true },
    ]);

    // Appending stays open — D9's own wording. A question nobody has been asked
    // cannot invalidate an answer nobody gave, and a running promotion routinely
    // needs a tie-breaker added.
    const appended = await client.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'Por que você merece?',
      p_options: [],
    });
    expect(appended.error).toBeNull();
    expect(appended.data).toBeTruthy();
  });

  // Not a freeze: 0052's ON UPDATE CASCADE plus its partial unique index. The
  // operator is stopped, which 0052 intended — but the sentence they were given
  // was about the site integration code, a field they never filled in, because
  // this violation and that one share sqlstate 23505.
  it('refuses to turn repeat entries off while one listener holds two, and names that rather than the site code', async () => {
    const label = `no-repeats-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Doze',
      phone: '11970000008',
    });

    // The window is captured rather than recomputed: the freeze refuses a start
    // date that differs by so much as a millisecond, and this promotion will
    // have a participation by the time it is edited.
    const starts = new Date(Date.now() - 2 * DAY).toISOString();
    const ends = new Date(Date.now() + 20 * DAY).toISOString();
    const promotionId = await promotionAsOwner(customer, {
      p_starts_at: starts,
      p_ends_at: ends,
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const entry = {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_source: 'MANUAL' as const,
      p_answers: [],
    };
    // Five hours apart against a one-hour interval, so both are VALID — the
    // partial index counts only VALID rows, and two TOO_SOON rows would not
    // trip it.
    const first = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 5 * HOUR).toISOString(),
    });
    const second = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base).toISOString(),
    });
    expect(first.data).toMatchObject({ status: 'VALID' });
    expect(second.data).toMatchObject({ status: 'VALID' });

    const denied = await client.rpc('update_promotion', {
      p_promotion_id: promotionId,
      p_name: 'Sem repetição',
      p_starts_at: starts,
      p_ends_at: ends,
      p_allow_multiple_entries: false,
    });

    // The sentence, not only the code, and here they are not interchangeable.
    // Before 0055 gave promotion_write_error a third case this came back as
    // "site integration code <NULL> is already used by another promotion in this
    // station" — same 23505, same handler, two cases. A code-only assertion
    // would have passed against that.
    expect(denied.error?.code).toBe('23505');
    expect(denied.error?.message).toBe(
      'somebody already has more than one entry in this promotion; repeat entries can no longer be turned off',
    );

    // And the promotion still allows repeats, because the whole update rolled
    // back rather than half-landing.
    const row = await client
      .from('promotions')
      .select('allow_multiple_entries, name')
      .eq('id', promotionId)
      .single();
    expect(row.data?.allow_multiple_entries).toBe(true);
    expect(row.data?.name).not.toBe('Sem repetição');
  });
});

/**
 * The `/participations` list read, driven through the service the screen calls
 * rather than through raw PostgREST.
 *
 * These cases exist because listParticipationsPage had nothing under it at all:
 * its two selects, its cursor and the permission boundary between them were
 * proved only by hand probes against a running stack, which stop proving
 * anything the moment somebody stops typing. Every case is driven by a NON-OWNER
 * delegate, for the reason members.test.ts's own header gives — the owner's
 * bypass hides precisely the failure a read policy is supposed to produce.
 * Owners appear here only as fixture setup.
 */
async function recordAsOwner(
  owner: SupabaseClient<Database>,
  promotionId: string,
  memberId: string,
  at: Date = new Date(),
): Promise<void> {
  const { error } = await owner.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: memberId,
    p_participated_at: at.toISOString(),
    p_source: 'MANUAL',
    p_answers: [],
  });
  if (error) throw new Error(`record_participation failed: ${error.message}`);
}

async function promotionAt(
  owner: SupabaseClient<Database>,
  companyId: string,
  name: string,
): Promise<string> {
  const { data, error } = await owner.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: name,
    p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
  });
  if (error) throw new Error(`create_promotion failed: ${error.message}`);
  return data as string;
}

/** The three codes the screen needs: the rows, the promotion behind them, and the listener. */
const FULL_READER = ['promotions.view', 'participations.view', 'members.view'];

describe('the participations list read', () => {
  it('shows a Station its own participations and nothing from the Station beside it', async () => {
    const label = `plist-tenant-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const stationB = await addCompany(customer, `Station B ${label}`);

    const promotionA = await promotionAt(owner, customer.companyId, 'Promo A');
    const promotionB = await promotionAt(owner, stationB, 'Promo B');
    const memberA = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte da Estacao A',
      phone: '11900000001',
    });
    const memberB = await createMemberAs(customer, stationB, {
      fullName: 'Ouvinte da Estacao B',
      phone: '11900000002',
    });

    await recordAsOwner(owner, promotionA, memberA);
    await recordAsOwner(owner, promotionB, memberB);

    // The delegate's role exists at Station A only — grantRoleWith's default.
    const delegate = await grantRoleWith(customer, label, FULL_READER);
    const token = await tokenFor(delegate);

    const atA = await listParticipationsPage(
      { companyId: customer.companyId, cursor: null, cursorSide: 'after' },
      token,
    );
    expect(atA.total).toBe(1);
    expect(atA.rows).toHaveLength(1);
    expect(atA.rows[0]?.promotionId).toBe(promotionA);
    expect(atA.rows[0]?.memberId).toBe(memberA);
    expect(atA.rows[0]?.promotionName).toBe('Promo A');
    expect(atA.rows[0]?.status).toBe('VALID');
    expect(atA.rows[0]?.source).toBe('MANUAL');

    // The same Organization, a Station this delegate holds no role in. It is
    // REFUSED rather than answered empty, and that changed in Block 6c.
    //
    // Under 0053's policies the read was legal and returned nothing, because
    // RLS filters rows and has no way to say why. list_participations (0090) is
    // SECURITY DEFINER, so it asks the two permissions itself — and a function
    // that has to ask can afford to answer. An empty page here would be
    // indistinguishable from "nobody has entered at that Station", which is the
    // one wrong idea this screen must not leave anybody with.
    //
    // Nothing leaks by refusing: the caller named the Station, so the refusal
    // tells them only what they already supplied. And the screen never asks
    // this question — listCompanyAccess offers only Stations the caller can
    // view, and a stale companyId falls back to the first of those — so this is
    // the boundary being proved directly rather than a path an operator walks.
    await expect(
      listParticipationsPage({ companyId: stationB, cursor: null, cursorSide: 'after' }, token),
    ).rejects.toThrow(/participations.view and promotions.view required/);
  });

  /**
   * The two selects, over ONE fixture and with the permission the only
   * difference between the two callers.
   *
   * listParticipationsPage swaps to an `!inner` embed when a search term is
   * present, because a search has to be a condition Postgres evaluates rather
   * than a filter over an already-fetched page — and member_company_links and
   * members are behind 0035's policies, which need members.view. So the two
   * selects genuinely can disagree about which rows exist, and this is the case
   * that pins where: without members.view the plain read still lists every
   * participation with the listener's name left null, and the searched read
   * finds nothing at all.
   *
   * Deliberately one case rather than two, with both callers reading the same
   * rows: two fixtures could differ, and then the assertion would be about the
   * fixtures rather than about the permission.
   */
  it('lists rows without the name to a delegate lacking members.view, and answers only the delegate who holds it when they search', async () => {
    const label = `plist-search-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const promotionId = await promotionAt(owner, customer.companyId, 'Promo da busca');
    const ana = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ana Isolada',
      phone: '11911111111',
    });
    const bruno = await createMemberAs(customer, customer.companyId, {
      fullName: 'Bruno Isolado',
      phone: '11922222222',
    });
    await recordAsOwner(owner, promotionId, ana);
    await recordAsOwner(owner, promotionId, bruno);

    const blind = await grantRoleWith(customer, `${label}-blind`, [
      'promotions.view',
      'participations.view',
    ]);
    const sighted = await grantRoleWith(customer, `${label}-sighted`, FULL_READER);
    const blindToken = await tokenFor(blind);
    const sightedToken = await tokenFor(sighted);

    const params = { companyId: customer.companyId, cursor: null, cursorSide: 'after' } as const;

    // Holding participations.view and not members.view: every row, no name.
    // This is the assertion that would fail if the plain select were ever made
    // `!inner` for symmetry with the searched one — the whole screen would empty
    // itself for a caller who is entitled to it.
    const blindPlain = await listParticipationsPage(params, blindToken);
    expect(blindPlain.total).toBe(2);
    expect(blindPlain.rows).toHaveLength(2);
    expect(blindPlain.rows.map((r) => r.listenerName)).toEqual([null, null]);
    expect(blindPlain.rows.map((r) => r.listenerPhoneLast4)).toEqual([null, null]);
    // The row itself is still fully readable — this is a hidden name, not a hidden row.
    expect(new Set(blindPlain.rows.map((r) => r.memberId))).toEqual(new Set([ana, bruno]));

    // The same caller searching: nothing, because they may not read the column
    // being searched. Asserted rather than left to discovery — it is the price
    // of making the search a query condition instead of a post-filter, and a
    // reader of this service should find it written down.
    const blindSearch = await listParticipationsPage({ ...params, search: 'Ana' }, blindToken);
    expect(blindSearch.rows).toHaveLength(0);
    expect(blindSearch.total).toBe(0);

    // And the same search, over the same rows, by a caller who holds members.view.
    const sightedPlain = await listParticipationsPage(params, sightedToken);
    expect(sightedPlain.rows.map((r) => r.listenerName).sort()).toEqual([
      'Ana Isolada',
      'Bruno Isolado',
    ]);

    const sightedSearch = await listParticipationsPage({ ...params, search: 'Ana' }, sightedToken);
    expect(sightedSearch.rows).toHaveLength(1);
    expect(sightedSearch.total).toBe(1);
    expect(sightedSearch.rows[0]?.memberId).toBe(ana);
    expect(sightedSearch.rows[0]?.listenerName).toBe('Ana Isolada');

    // By phone digits too, which take the cpf_last_digits/phone_normalized arm
    // of the same `or` — clauses that resolve inside the nested embed or do not,
    // and nothing but a live read can say which.
    const byDigits = await listParticipationsPage({ ...params, search: '922222222' }, sightedToken);
    expect(byDigits.rows).toHaveLength(1);
    expect(byDigits.rows[0]?.memberId).toBe(bruno);
  });

  it('reads one row past the page and returns it as the signal that there is more, never as a result', async () => {
    const label = `plist-page-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const promotionId = await promotionAt(owner, customer.companyId, 'Promo cheia');

    // Exactly one more than a page. Distinct listeners rather than repeats, so
    // every row is VALID and participations_one_per_member is not what is under
    // test here. Seeded on ONE signed-in client — createMemberAs signs in per
    // call, which is twenty-six needless auth round trips at this size.
    const total = PARTICIPATION_PAGE_SIZE + 1;
    const memberIds: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const { data, error } = await owner.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: `Ouvinte ${String(i).padStart(2, '0')}`,
        p_phone: `1193000${String(i).padStart(4, '0')}`,
      });
      if (error) throw new Error(`create_member failed at ${i}: ${error.message}`);
      memberIds.push(data as string);
    }
    for (let i = 0; i < total; i += 1) {
      // Spread through the window so participated_at does not tie across the
      // page boundary for reasons unrelated to the cursor. The tiebreak on id is
      // what handles a genuine tie, and listing.test.ts already proves that one.
      await recordAsOwner(owner, promotionId, memberIds[i]!, new Date(Date.now() - i * HOUR));
    }

    const delegate = await grantRoleWith(customer, label, FULL_READER);
    const token = await tokenFor(delegate);
    const params = { companyId: customer.companyId, cursorSide: 'after' } as const;

    const first = await listParticipationsPage({ ...params, cursor: null }, token);
    // A page, not a page and the extra row. The read asked for PAGE_SIZE + 1 and
    // the surplus row's only job was to populate nextCursor.
    expect(first.rows).toHaveLength(PARTICIPATION_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(first.previousCursor).toBeNull();
    expect(first.total).toBe(total);

    const second = await listParticipationsPage(
      { ...params, cursor: decodeCursor(first.nextCursor) },
      token,
    );
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.previousCursor).not.toBeNull();

    // The row that signalled "there is more" is the one the next page opens
    // with, and it was not also rendered on the first — the two halves of the
    // off-by-one this convention exists to get right.
    const rows = [...first.rows, ...second.rows];
    expect(new Set(rows.map((r) => r.id)).size).toBe(total);
    expect(first.rows.map((r) => r.id)).not.toContain(second.rows[0]?.id);

    // Newest first, which is what participations_listing_idx carries and what
    // the screen claims. A cursor that resumed on the wrong side would still
    // fill both pages.
    const instants = rows.map((r) => Date.parse(r.participatedAt));
    expect(instants).toEqual([...instants].sort((a, b) => b - a));

    // And back again through previousCursor, which nothing exercised anywhere:
    // no caller in this repository passes `cursorSide: 'before'`, and the e2e
    // clicks page-next and never page-previous. listParticipationsPage collapses
    // listPromotionsPage's two-variable form into `const ascending = walkingBack`
    // (services/participations.ts) because the display order is fixed
    // descending, then leans on keysetPage to reverse the rows back — an
    // inversion with two chances to be wrong and, until this line, no proof
    // either way. Asserted on the ORDER as well as the set: reading the page
    // back upside down would satisfy a set comparison perfectly.
    const back = await listParticipationsPage(
      { ...params, cursor: decodeCursor(second.previousCursor), cursorSide: 'before' },
      token,
    );
    expect(back.rows).toHaveLength(PARTICIPATION_PAGE_SIZE);
    expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  /**
   * The archived-promotion sub-clause of 0053's read policy, which had no
   * proof anywhere.
   *
   * `participations_select_participations_view` is `has_permission(...) and
   * promotion_id in (select id from public.promotions)`, and 0053's own comment
   * argues at length that the second half is not redundant with the first: the
   * subquery is itself filtered by 0044's policy on promotions, which hides an
   * archived promotion from everyone but the Organization owner and the
   * platform admin. Without it, a delegate who kept an id could go on reading
   * the participations of a promotion that has left every one of their other
   * reads. Delete both sub-clauses and, before this case, every suite in the
   * repository stayed green.
   *
   * The live sibling is what makes this an assertion rather than an empty-set
   * trap. A policy that denied everything, a fixture that wrote nothing, and a
   * delegate with no permission at all would each produce the same zero; only a
   * second promotion whose rows DO come back, through the same call with the
   * same token, tells them apart.
   */
  it('hides an archived promotion\'s entries and its answers, while a live promotion beside it still lists', async () => {
    const label = `plist-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Arquivado',
      phone: '11944444441',
    });

    // archive_promotion (0042) refuses a promotion that is still taking
    // entries, so this one has to have ended — and the entry below is stamped
    // INSIDE that past window, because apply_participation refuses anything
    // outside it.
    const { data: endedId, error: endedError } = await owner.rpc('create_promotion', {
      p_company_id: customer.companyId,
      p_name: 'Promo arquivada',
      p_starts_at: new Date(Date.now() - 3 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() - DAY).toISOString(),
    });
    if (endedError) throw new Error(`create_promotion failed: ${endedError.message}`);
    const archivedId = endedId as string;

    const { data: questionId, error: questionError } = await owner.rpc('save_promotion_question', {
      p_promotion_id: archivedId,
      p_kind: 'ESSAY',
      p_prompt: 'Por que você ouve?',
      p_options: [],
    });
    if (questionError) throw new Error(`save_promotion_question failed: ${questionError.message}`);

    const entered = await owner.rpc('record_participation', {
      p_promotion_id: archivedId,
      p_member_id: memberId,
      p_participated_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_source: 'MANUAL',
      p_answers: [{ question_id: questionId, answer_text: 'Pela música' }],
    });
    // Asserted rather than assumed: a fixture that failed here would leave
    // nothing to hide, and every assertion below would pass against a policy
    // with no sub-clause at all.
    expect(entered.error).toBeNull();
    expect(entered.data).toMatchObject({ status: 'VALID' });

    const liveId = await promotionAt(owner, customer.companyId, 'Promo viva');
    await recordAsOwner(owner, liveId, memberId);

    const archived = await owner.rpc('archive_promotion', { p_promotion_id: archivedId });
    expect(archived.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, FULL_READER);
    const token = await tokenFor(delegate);
    const client = await clientFor(delegate);
    const params = { companyId: customer.companyId, cursor: null, cursorSide: 'after' } as const;

    // Gone from the list, and the TOTAL is gone with it — a count taken outside
    // the policy would report a row the page will not show.
    const onArchived = await listParticipationsPage({ ...params, promotionId: archivedId }, token);
    expect(onArchived.rows).toHaveLength(0);
    expect(onArchived.total).toBe(0);

    // The sibling, same caller, same call: still there. This is the half that
    // makes the zero above mean something.
    const onLive = await listParticipationsPage({ ...params, promotionId: liveId }, token);
    expect(onLive.rows).toHaveLength(1);
    expect(onLive.total).toBe(1);
    expect(onLive.rows[0]?.promotionId).toBe(liveId);

    // And unfiltered, which is what the screen opens on: exactly one row, the
    // live one. The archived promotion's entry is not merely un-navigable, it
    // is not in the Station's list at all.
    const everything = await listParticipationsPage(params, token);
    expect(everything.total).toBe(1);
    expect(everything.rows.map((r) => r.promotionId)).toEqual([liveId]);

    // One level down, and it is a policy of its own (0053) rather than a
    // consequence of the one above: participation_answers carries the same
    // archived rule through `participation_id in (select id from
    // public.participations)`. The answer exists — the fixture asserted the
    // entry that holds it — so this zero is a denial.
    const answers = await client
      .from('participation_answers')
      .select('id')
      .eq('promotion_id', archivedId);
    expect(answers.error).toBeNull();
    expect(answers.data).toEqual([]);
  });

  /**
   * Block 30a D1, the mirror of list_pickups' own case. The whole number
   * stopped travelling here too, and the pair matters more than either half:
   * WITHHELD and MASKED are different facts. A caller without members.view
   * still gets null -- not four digits -- because list_participations' own
   * branch (0090) is about whether they may know the listener at all, and
   * narrowing the projection must not quietly answer that question with
   * "a little".
   */
  it('sends four digits to members.view, and still nothing without it', async () => {
    const label = `plist-mask-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const promotionId = await promotionAt(owner, customer.companyId, 'Promo mask');
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte mascarado',
      phone: '11985954985',
    });
    await recordAsOwner(owner, promotionId, memberId);

    const { data: asOwner } = await owner.rpc('list_participations', {
      p_company_id: customer.companyId,
    });
    const row = (asOwner ?? []).find((r) => r.member_id === memberId);
    expect(row?.listener_phone_last4).toBe('4985');
    expect(JSON.stringify(asOwner)).not.toContain('11985954985');

    const stranger = await grantRoleWith(customer, `${label}-stranger`, [
      'promotions.view',
      'participations.view',
    ]);
    const strangerClient = await signInAs(stranger.email, stranger.password);
    const { data: asStranger } = await strangerClient.rpc('list_participations', {
      p_company_id: customer.companyId,
    });
    const withheld = (asStranger ?? []).find((r) => r.member_id === memberId);
    expect(withheld).toBeDefined();
    expect(withheld?.listener_phone_last4).toBeNull();
  });
});

/**
 * `participation_answers` on its own, because until this fix round the table
 * that holds listeners' free-text answers had no denial proof anywhere.
 *
 * pgTAP asserted that a policy exists, which `using (true)` satisfies; the
 * fail-closed stranger view covered `public.participations` only; and the one
 * live read of the table in this suite is by a delegate who HOLDS
 * participations.view, so it could only ever show the permitted direction.
 * 05_participations.test.sql now carries the stranger half. This is the tenancy
 * half: a real delegate, at a real Station, denied a neighbour's answers.
 */
describe('the answers read gate', () => {
  it("shows a Station its own answers and none of the Station beside it", async () => {
    const label = `pans-tenant-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);

    const stationB = await addCompany(customer, `Station B ${label}`);

    const promotionA = await promotionAt(owner, customer.companyId, 'Promo com respostas');
    const { data: questionId, error: questionError } = await owner.rpc('save_promotion_question', {
      p_promotion_id: promotionA,
      p_kind: 'ESSAY',
      p_prompt: 'Conte uma história',
      p_options: [],
    });
    if (questionError) throw new Error(`save_promotion_question failed: ${questionError.message}`);

    const ana = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ana das Respostas',
      phone: '11955555551',
    });
    const bruno = await createMemberAs(customer, customer.companyId, {
      fullName: 'Bruno das Respostas',
      phone: '11955555552',
    });

    for (const [memberId, text] of [
      [ana, 'Ouço desde criança'],
      [bruno, 'Pela música da tarde'],
    ] as const) {
      const { error } = await owner.rpc('record_participation', {
        p_promotion_id: promotionA,
        p_member_id: memberId,
        p_participated_at: new Date().toISOString(),
        p_source: 'MANUAL',
        p_answers: [{ question_id: questionId, answer_text: text }],
      });
      if (error) throw new Error(`record_participation failed: ${error.message}`);
    }

    // Two delegates, one Organization, one role definition each — the only
    // difference between them is WHICH Station the role was granted at.
    const atA = await grantRoleWith(customer, `${label}-a`, [
      'promotions.view',
      'participations.view',
    ]);
    const atB = await grantRoleWith(
      customer,
      `${label}-b`,
      ['promotions.view', 'participations.view'],
      [stationB],
    );

    const clientA = await clientFor(atA);
    const clientB = await clientFor(atB);

    const readA = await clientA
      .from('participation_answers')
      .select('answer_text')
      .eq('promotion_id', promotionA);
    expect(readA.error).toBeNull();
    expect(readA.data).toHaveLength(2);

    // The same question of the same rows, by somebody holding the same
    // permission at the Station next door. Rewrite 0053's second policy
    // `using (true)` and this is the assertion that goes red.
    const readB = await clientB
      .from('participation_answers')
      .select('answer_text')
      .eq('promotion_id', promotionA);
    expect(readB.error).toBeNull();
    expect(readB.data).toEqual([]);
  });
});

/**
 * The two service functions this block shipped with no coverage at any layer.
 *
 * `countPromotionParticipations` is load-bearing rather than decorative: it is
 * what the promotion record's fifth tab shows, and the e2e's compensating
 * assertion — the number a dead browser could not have computed — is the number
 * it produces. `searchStationListeners` had two claims that existed only in its
 * own prose.
 */
describe('the fifth tab’s counts and the manual form’s picker', () => {
  /**
   * `refused` is `neq('status', 'VALID')`, which is one filter standing in for
   * three statuses, and nothing proved it caught all three.
   *
   * TWO promotions, because one cannot hold all three: DUPLICATE only ever
   * arises where `allow_multiple_entries` is false, and OVER_LIMIT needs a
   * ceiling, which `promotions_entry_ceiling_shape` (0052) permits only where
   * repeats ARE allowed. That is a structural fact about the schema rather than
   * an awkward fixture, so it is written down instead of worked around.
   */
  it('counts every refusal status as refused, across the two promotion shapes that can produce them', async () => {
    const label = `pcount-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Contado',
      phone: '11966666661',
    });

    const starts = new Date(Date.now() - 3 * DAY).toISOString();
    const ends = new Date(Date.now() + 20 * DAY).toISOString();

    // Shape one: repeats allowed, a six-hour interval and a ceiling of two.
    // VALID, VALID, TOO_SOON, OVER_LIMIT.
    const repeatable = await promotionAsOwner(customer, {
      p_starts_at: starts,
      p_ends_at: ends,
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });
    const ceiling = await owner.rpc('update_promotion', {
      p_promotion_id: repeatable,
      p_name: 'Com teto para contagem',
      p_starts_at: starts,
      p_ends_at: ends,
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
      p_max_entries_per_member: 2,
    });
    expect(ceiling.error).toBeNull();

    const base = Date.now();
    const at = async (promotionId: string, offsetHours: number) => {
      const { data, error } = await owner.rpc('record_participation', {
        p_promotion_id: promotionId,
        p_member_id: memberId,
        p_participated_at: new Date(base - offsetHours * HOUR).toISOString(),
        p_source: 'MANUAL',
        p_answers: [],
      });
      if (error) throw new Error(`record_participation failed: ${error.message}`);
      return (data as { status: string }).status;
    };

    // Asserted one by one rather than trusted, because the whole case is about
    // which status each row ended up with — a fixture that produced four
    // TOO_SOONs would still make `refused` equal 2 by accident.
    expect(await at(repeatable, 30)).toBe('VALID');
    expect(await at(repeatable, 29)).toBe('TOO_SOON');
    expect(await at(repeatable, 20)).toBe('VALID');
    expect(await at(repeatable, 4)).toBe('OVER_LIMIT');

    // Shape two: repeats forbidden, so the second attempt is a DUPLICATE — the
    // one status the promotion above cannot produce.
    const once = await promotionAsOwner(customer, { p_starts_at: starts, p_ends_at: ends });
    expect(await at(once, 10)).toBe('VALID');
    expect(await at(once, 9)).toBe('DUPLICATE');

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
    ]);
    const token = await tokenFor(delegate);

    expect(await countPromotionParticipations(repeatable, token)).toEqual({ valid: 2, refused: 2 });
    expect(await countPromotionParticipations(once, token)).toEqual({ valid: 1, refused: 1 });

    // A delegate holding no participations.view at this Station: zeroes, not an
    // error and not the real figures. 0053's policy answers a caller it does not
    // admit with no rows, so the two counts come back 0/0 — which is what the
    // tab renders behind its own `powers.participationsView` check, and what
    // must never be a leak by another route.
    const blind = await grantRoleWith(customer, `${label}-blind`, ['promotions.view']);
    const blindToken = await tokenFor(blind);
    expect(await countPromotionParticipations(repeatable, blindToken)).toEqual({
      valid: 0,
      refused: 0,
    });
  });

  /**
   * The picker's two claims, both of which existed only in the prose above
   * `searchStationListeners`.
   *
   * Station-scoped rather than Organization-scoped is the whole reason that
   * function is not `listOrganizationMembers` with a term: apply_participation
   * (0054) refuses a listener the promotion's Station is not linked to, so a
   * picker offering a sister-Station listener produces a guaranteed P0002 the
   * moment the operator submits. The delegate below holds members.view at BOTH
   * Stations, so an Organization-wide read would legitimately return the
   * neighbour — which is exactly what makes the assertion about the scope of the
   * query rather than about the caller's permissions.
   *
   * And an anonymised listener is excluded: 0034 scrubs full_name, so the row
   * would otherwise be offered as a blank line nobody can identify, and
   * recording a fresh entry against somebody who exercised erasure is precisely
   * what that erasure was for.
   */
  it('offers only this Station’s listeners, and never an anonymised one', async () => {
    const label = `picker-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await clientFor(customer);
    const stationB = await addCompany(customer, `Station B ${label}`);

    // One shared surname, so a single term reaches all three and the only thing
    // separating them is the rule under test.
    const here = await createMemberAs(customer, customer.companyId, {
      fullName: 'Silveira Aqui',
      phone: '11977777771',
    });
    await createMemberAs(customer, stationB, {
      fullName: 'Silveira Vizinha',
      phone: '11977777772',
    });
    const erased = await createMemberAs(customer, customer.companyId, {
      fullName: 'Silveira Apagada',
      phone: '11977777773',
    });

    const { error: erasureError } = await owner.rpc('anonymize_member', {
      p_member_id: erased,
      p_reason: 'subject_request',
    });
    if (erasureError) throw new Error(`anonymize_member failed: ${erasureError.message}`);

    const delegate = await grantRoleWith(
      customer,
      label,
      ['promotions.view', 'participations.view', 'participations.create', 'members.view'],
      // Both Stations. Without this the case would pass against an
      // Organization-wide query too, and would be testing the role rather than
      // the function.
      [customer.companyId, stationB],
    );
    const token = await tokenFor(delegate);

    const page = await searchStationListeners(customer.companyId, 'Silveira', token);
    expect(page.listeners.map((l) => l.memberId)).toEqual([here]);
    expect(page.hasMore).toBe(false);

    // And the neighbour IS reachable to this same caller through the Station
    // they belong to — so the empty answer above is a scope, not a denial.
    const neighbours = await searchStationListeners(stationB, 'Silveira', token);
    expect(neighbours.listeners.map((l) => l.fullName)).toEqual(['Silveira Vizinha']);
  });

  /**
   * Block 24, item 6. The View window's own read.
   *
   * `getParticipationAnswers` is SECURITY INVOKER — a plain PostgREST select with
   * two embeds — so what it returns is decided entirely by 0053's and 0044's
   * policies. That is exactly why it needs a real JWT to prove: pgTAP runs as a
   * superuser with no session user, and RLS never applies to it at all.
   */
  it('reads one participation’s answers, question text and verdict included', async () => {
    const label = `part-answers-read-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte das Respostas',
      phone: '11988887799',
    });
    const promotionId = await promotionAsOwner(customer);

    const owner = await clientFor(customer);
    const { data: quizId } = await owner.rpc('save_promotion_question', {
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
    const { data: essayId } = await owner.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'Por que essa música?',
      p_options: [],
    });
    // The internal guidance the window shows above the written answer.
    const guidelines = await owner.rpc('set_question_moderation_guidelines', {
      p_question_id: essayId as string,
      p_guidelines: 'Prefira uma memória a uma resenha.',
    });
    expect(guidelines.error).toBeNull();

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: options } = await client
      .from('promotion_question_options')
      .select('id, label')
      .eq('question_id', quizId as string);
    const argentina = options!.find((o) => o.label === 'Argentina')!.id;

    const recorded = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_source: 'MANUAL' as const,
      p_participated_at: new Date().toISOString(),
      p_answers: [
        { question_id: quizId, option_id: argentina },
        { question_id: essayId, answer_text: 'Tocou no dia em que conheci minha esposa.' },
      ],
    });
    expect(recorded.error).toBeNull();
    const participationId = (recorded.data as { participation_id: string }).participation_id;

    const answers = await getParticipationAnswers(participationId, await tokenFor(delegate));

    // Ordered by the QUESTION's position, which is how the quiz was asked — the
    // answers table has no order of its own.
    expect(answers).toHaveLength(2);
    expect(answers[0]?.prompt).toBe('Quem ganha a Copa?');
    expect(answers[0]?.optionLabel).toBe('Argentina');
    // The verdict is DERIVED from the chosen option, never stored on the answer
    // (0052's own comment). A wrong pick reports false rather than null.
    expect(answers[0]?.optionIsCorrect).toBe(false);
    expect(answers[0]?.moderationGuidelines).toBeNull();

    expect(answers[1]?.prompt).toBe('Por que essa música?');
    expect(answers[1]?.answerText).toBe('Tocou no dia em que conheci minha esposa.');
    expect(answers[1]?.optionLabel).toBeNull();
    expect(answers[1]?.moderationGuidelines).toBe('Prefira uma memória a uma resenha.');
  });

  it('returns nothing to a caller who cannot reach the Station', async () => {
    const label = `part-answers-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Reservado',
      phone: '11988887798',
    });
    const promotionId = await promotionAsOwner(customer);

    const insider = await grantRoleWith(customer, `${label}-in`, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const recorded = await (
      await clientFor(insider)
    ).rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_source: 'MANUAL' as const,
      p_participated_at: new Date().toISOString(),
      p_answers: [],
    });
    expect(recorded.error).toBeNull();
    const participationId = (recorded.data as { participation_id: string }).participation_id;

    // A delegate of ANOTHER Station in the same Organization, holding every
    // permission this read needs — there, and only there.
    const stationB = await addCompany(customer, `Station B ${label}`);
    const outsider = await grantRoleWith(
      customer,
      `${label}-out`,
      ['promotions.view', 'participations.view'],
      [stationB],
    );

    // EMPTY, not an error: this is a select under RLS, and a row a policy hides
    // is a row that does not exist. The window renders "this promotion asked
    // nothing", which is the honest report of what this caller can see.
    const answers = await getParticipationAnswers(participationId, await tokenFor(outsider));
    expect(answers).toHaveLength(0);
  });
});
