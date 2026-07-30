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

    const owner = await clientFor(customer);
    await owner.rpc('update_promotion', {
      p_promotion_id: promotionId,
      p_name: 'Com teto',
      p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
      p_max_entries_per_member: 2,
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

    const a = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base - 5 * HOUR).toISOString() });
    const b = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base - 3 * HOUR).toISOString() });
    const c = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base).toISOString() });

    expect(a.data).toMatchObject({ status: 'VALID' });
    expect(b.data).toMatchObject({ status: 'VALID' });
    // The ceiling counts VALID entries only, so the third is refused for the
    // ceiling and not for the interval — which is why the fixture leaves two
    // hours between each.
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

  // This is the case N3 exists for, and the one the mutation in Task 10 targets.
  it('lets exactly one of two simultaneous entries be VALID', async () => {
    const label = `part-race-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Oito',
      phone: '11988887775',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    // Two separate clients, so the two calls are two connections rather than
    // two statements queued on one.
    const a = await clientFor(delegate);
    const b = await clientFor(delegate);

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
  });
});
