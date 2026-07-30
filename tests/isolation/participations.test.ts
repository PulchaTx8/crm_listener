import { afterAll, describe, expect, it } from 'vitest';
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

  // The OVER_LIMIT case lives in Task 5, not here. Its fixture has to set the
  // ceiling, and the only way to set it is update_promotion's
  // p_max_entries_per_member — an argument that RPC does not have until Task 5
  // drops and recreates it. Written here it could only sit red, and it could not
  // be skipped either: the isolation guard fails closed on a pending or todo
  // test, so one .skip breaks the gate for everybody after it.
  //
  // Which leaves the fourth status unexercised until then. Deliberate and
  // recorded, not forgotten.

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
