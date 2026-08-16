import { afterAll, describe, expect, it } from 'vitest';
import {
  archivePromotion,
  cancelPromotion,
  createPromotion,
  getPromotionRecord,
  removePromotionQuestion,
  savePromotionQuestion,
  setQuestionModerationGuidelines,
  updatePromotion,
} from '@/services/promotions';
// Block 24, D3: the two the Quiz screen stopped collecting and the door now
// supplies. Imported rather than repeated as literals, so a change to the copy
// cannot leave this test asserting wording nothing writes.
import {
  DEFAULT_QUESTION_BUTTON_LABEL,
  DEFAULT_QUESTION_MENU_TITLE,
} from '@/lib/conversation/engine';
import type { PromotionFormInput } from '@/schemas/promotions';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

/**
 * Block 4a's five write RPCs and its three read policies, driven end to end.
 *
 * Every case is driven by a NON-OWNER delegate, for the reason members.test.ts's
 * own header gives: Block 1c shipped two defects that thirteen reviews missed
 * because every scenario had the owner driving, and the owner's bypass hid the
 * delegate's failure. The owner appears below as fixture setup, and as the
 * actor of exactly one assertion — the half of D12 that is ABOUT the owner
 * seeing what the delegate cannot.
 *
 * 0042's four functions have no pgTAP of their own on purpose: an assertion
 * that they exist would pass with every body wrong. This file is their proof.
 */
async function tokenFor(email: string, password: string): Promise<string> {
  const client = await signInAs(email, password);
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(`no access token for ${email}`);
  return token;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Inside its window now: what "No ar" means, and what archiving must refuse. */
function liveWindow() {
  return {
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  };
}

/** Not started yet. Cancellable, and archivable without cancelling first. */
function futureWindow() {
  return {
    startsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  };
}

/** Already over. Nothing left to cancel. */
function pastWindow() {
  return {
    startsAt: new Date(Date.now() - 30 * DAY).toISOString(),
    endsAt: new Date(Date.now() - HOUR).toISOString(),
  };
}

function promotionInput(
  companyId: string,
  overrides: Partial<PromotionFormInput> = {},
): PromotionFormInput {
  return {
    companyId,
    name: 'Galaxy S25 Ultra',
    ...liveWindow(),
    allowMultipleEntries: false,
    requireCorrectAnswer: false,
    whatsappEnabled: false,
    useArt: false,
    requestedFields: [],
    ...overrides,
  } as PromotionFormInput;
}

/** Registers a promotion as the owner. Fixture setup, never the operation under test. */
async function createAsOwner(
  customer: ProvisionedCustomer,
  overrides: Partial<PromotionFormInput> = {},
): Promise<string> {
  const token = await tokenFor(customer.email, customer.password);
  return createPromotion(promotionInput(customer.companyId, overrides), token);
}

describe('the promotion record', () => {
  describe('reading', () => {
    it('returns the promotion and its quiz to a delegate with promotions.view', async () => {
      const label = `promo-read-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, {
        whatsappEnabled: true,
        hashtag: '#EUQUERO',
        requestedFields: ['full_name', 'city'],
      });

      const ownerToken = await tokenFor(customer.email, customer.password);
      await savePromotionQuestion(
        promotionId,
        null,
        {
          kind: 'QUIZ',
          prompt: 'Which country wins the 2026 World Cup?',
          options: [
            { label: 'Brazil', isCorrect: true },
            { label: 'Argentina', isCorrect: false },
          ],
        },
        ownerToken,
      );

      const delegate = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      const record = await getPromotionRecord(promotionId, token);
      expect(record).not.toBeNull();
      expect(record?.name).toBe('Galaxy S25 Ultra');
      expect(record?.hashtag).toBe('#EUQUERO');
      expect(record?.requestedFields).toEqual(['full_name', 'city']);

      // The quiz is what proves the read reached past the promotions row into
      // both child tables, each governed by its own policy.
      expect(record?.questions).toHaveLength(1);
      expect(record?.questions[0]?.options.map((o) => o.label)).toEqual(['Brazil', 'Argentina']);
      expect(record?.questions[0]?.options.filter((o) => o.isCorrect)).toHaveLength(1);
    });

    it('returns nothing to a delegate without promotions.view', async () => {
      const label = `promo-read-noperm-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      // Reachable Station, but no promotions.view anywhere in the role.
      const delegate = await grantRoleWith(customer, label, ['members.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      expect(await getPromotionRecord(promotionId, token)).toBeNull();
    });

    it('returns nothing for a promotion at another Station', async () => {
      const label = `promo-read-other-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');
      const promotionId = await createAsOwner(customer, { companyId: stationB });

      // Holds promotions.view, but only at Station A.
      const delegate = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      expect(await getPromotionRecord(promotionId, token)).toBeNull();
    });
  });

  describe('registering', () => {
    it('lands for a delegate with promotions.create, and stores what it was given', async () => {
      const label = `promo-create-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const delegate = await grantRoleWith(customer, label, [
        'promotions.create',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      const promotionId = await createPromotion(
        promotionInput(customer.companyId, {
          name: 'Delegate promotion',
          whatsappEnabled: true,
          hashtag: '#DELEGADO',
          // No banner here as of Block 14: it is not a field of this form and
          // create_promotion does not take one. A promotion is born without
          // pictures because neither storage key exists until the row does.
          //
          // No button labels either, as of Block 24: they are not fields of this
          // form any more, and the service sends null for both. What a listener
          // reads on the two consent buttons is engine.ts's own copy.
          requestedFields: ['full_name', 'address', 'city'],
          allowMultipleEntries: true,
          minHoursBetweenEntries: 24,
        }),
        token,
      );

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.name).toBe('Delegate promotion');
      expect(record?.requestedFields).toEqual(['full_name', 'address', 'city']);
      expect(record?.minHoursBetweenEntries).toBe(24);

      // A PROMOTION IS BORN WITHOUT PICTURES, and this asserts it rather than
      // merely stopping asserting the opposite. Neither storage key exists
      // until the row does, so create_promotion stopped taking the banner in
      // Block 14 (0144) and the registering action uploads afterwards, against
      // the id that comes back. use_art follows the address it has always been
      // constrained to agree with (promotions_art_shape).
      expect(record?.useArt).toBe(false);
      expect(record?.artUrl).toBeNull();
      expect(record?.thumbUrl).toBeNull();
    });

    /**
     * The per-person ceiling, through the SERVICE, in both directions.
     *
     * This is the closure for Task 10's fourth mutation — the one that survived
     * every gate. Deleting `p_max_entries_per_member` from `promotionRpcArgs`
     * (`src/services/promotions.ts`) passed lint, typecheck, 321 unit tests,
     * 391 pgTAP assertions, 175 isolation cases and 18 e2e journeys. `typecheck`
     * is structurally blind because the argument is optional in
     * `database.types.ts`; this file drove both doors through that very builder
     * twenty times over and never once set a ceiling; and the only live proof of
     * the ceiling anywhere called `update_promotion` DIRECTLY, bypassing the
     * service entirely.
     *
     * The second half is the one that matters, and it is the half that would
     * have shipped broken. `update_promotion` assigns
     * `max_entries_per_member = p_max_entries_per_member` with no `coalesce`
     * (`0055`), and `promotionRpcArgs`'s own comment records that an absent key
     * is omitted by PostgREST so the function's `default null` applies. So with
     * that one line gone, a ceiling typed into the form appears to save and is
     * written null — AND an edit to any other field on a promotion that already
     * has one silently removes it, which needs nobody to be looking.
     */
    it('carries the per-person ceiling to both doors, and an unrelated edit does not remove it', async () => {
      const label = `promo-ceiling-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const delegate = await grantRoleWith(customer, label, [
        'promotions.create',
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      // Born with one. 0052's promotions_entry_ceiling_shape permits a ceiling
      // only where repeats are allowed and only at two or more, so the window
      // and the repeat rules are part of the fixture rather than decoration.
      const window = liveWindow();
      const base = {
        ...window,
        allowMultipleEntries: true,
        minHoursBetweenEntries: 6,
        maxEntriesPerMember: 3,
      };
      const promotionId = await createPromotion(
        promotionInput(customer.companyId, { name: 'Com teto', ...base }),
        token,
      );

      const born = await getPromotionRecord(promotionId, token);
      expect(born?.maxEntriesPerMember).toBe(3);

      // The wholesale replace: every field posted again, only the name
      // different. This is what one ordinary edit on the Promotion tab does.
      await updatePromotion(
        promotionId,
        promotionInput(customer.companyId, { name: 'Nome novo, mesmo teto', ...base }),
        token,
      );

      const edited = await getPromotionRecord(promotionId, token);
      expect(edited?.name).toBe('Nome novo, mesmo teto');
      expect(edited?.maxEntriesPerMember).toBe(3);
    });

    it('is refused without promotions.create, and writes nothing', async () => {
      const label = `promo-create-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const delegate = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(
        createPromotion(promotionInput(customer.companyId, { name: 'Should not exist' }), token),
      ).rejects.toThrow(/permission denied: promotions\.create required/);

      // The refusal has to leave nothing behind, not merely return an error.
      const client = await signInAs(customer.email, customer.password);
      const { data } = await client
        .from('promotions')
        .select('id')
        .eq('company_id', customer.companyId);
      expect(data ?? []).toHaveLength(0);
    });

    it('refuses a hashtag already live in the Station, naming it', async () => {
      const label = `promo-hashtag-${Date.now()}`;
      const customer = await provisionCustomer(label);
      await createAsOwner(customer, { whatsappEnabled: true, hashtag: '#EUQUERO' });

      const delegate = await grantRoleWith(customer, label, ['promotions.create']);
      const token = await tokenFor(delegate.email, delegate.password);

      // The sentence matters as much as the refusal: a raw 23P01 reaching a
      // screen reads like nothing an operator has ever seen.
      await expect(
        createPromotion(
          promotionInput(customer.companyId, {
            name: 'Same hashtag',
            whatsappEnabled: true,
            hashtag: '#EUQUERO',
          }),
          token,
        ),
      ).rejects.toThrow(/already uses "#EUQUERO" during that period/);
    });
  });

  describe('editing', () => {
    it('lands for a delegate with promotions.edit, clearing what the form cleared', async () => {
      const label = `promo-edit-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, {
        // Block 24 took `callToAction` off this form, so the field that proves
        // the wholesale replace is now the site integration code: optional,
        // still on the form, and cleared by an update that omits it. What is
        // being tested is unchanged — that update_promotion replaces every
        // field rather than merging — only which field carries the proof.
        siteIntegrationCode: 4242,
        whatsappEnabled: true,
        hashtag: '#ANTES',
      });

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await updatePromotion(
        promotionId,
        promotionInput(customer.companyId, {
          name: 'Edited',
          whatsappEnabled: true,
          hashtag: '#DEPOIS',
        }),
        token,
      );

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.name).toBe('Edited');
      expect(record?.hashtag).toBe('#DEPOIS');
      // The wholesale replace is the point: a field left out of the submission
      // is cleared, not kept.
      expect(record?.siteIntegrationCode).toBeNull();
    });

    it('is refused without promotions.edit, and leaves the row alone', async () => {
      const label = `promo-edit-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, { name: 'Untouched' });

      const delegate = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(
        updatePromotion(promotionId, promotionInput(customer.companyId, { name: 'Hijacked' }), token),
      ).rejects.toThrow(/permission denied: promotions\.edit required/);

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.name).toBe('Untouched');
    });
  });

  describe('cancelling', () => {
    it('stops the promotion and records who and why', async () => {
      const label = `promo-cancel-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.cancel',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await cancelPromotion(promotionId, 'Prize supplier withdrew', token);

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.cancelledAt).not.toBeNull();
      expect(record?.cancellationReason).toBe('Prize supplier withdrew');
    });

    it('refuses a cancellation with no reason', async () => {
      const label = `promo-cancel-noreason-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, ['promotions.cancel']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(cancelPromotion(promotionId, '   ', token)).rejects.toThrow(
        /a reason is required to cancel a promotion/,
      );
    });

    it('refuses cancelling something already cancelled', async () => {
      const label = `promo-cancel-twice-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, ['promotions.cancel']);
      const token = await tokenFor(delegate.email, delegate.password);

      await cancelPromotion(promotionId, 'First', token);
      await expect(cancelPromotion(promotionId, 'Second', token)).rejects.toThrow(
        /already cancelled/,
      );
    });

    it('refuses cancelling something already over', async () => {
      const label = `promo-cancel-past-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, pastWindow());

      const delegate = await grantRoleWith(customer, label, ['promotions.cancel']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(cancelPromotion(promotionId, 'Too late', token)).rejects.toThrow(
        /already ended; there is nothing to cancel/,
      );
    });
  });

  describe('archiving', () => {
    it('is refused while the promotion is still accepting entries', async () => {
      const label = `promo-archive-live-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, ['promotions.archive']);
      const token = await tokenFor(delegate.email, delegate.password);

      // Not caution: archiving frees the hashtag, so doing it mid-flight would
      // let another promotion claim one listeners are still texting.
      await expect(archivePromotion(promotionId, token)).rejects.toThrow(
        /still accepting entries; cancel it before archiving/,
      );
    });

    it('lands once the promotion has been cancelled', async () => {
      const label = `promo-archive-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.cancel',
        'promotions.archive',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await cancelPromotion(promotionId, 'Called off', token);
      await archivePromotion(promotionId, token);

      // Gone for the delegate who could read it a moment ago.
      expect(await getPromotionRecord(promotionId, token)).toBeNull();
    });

    it('leaves an archived promotion readable by the owner, naming who archived it', async () => {
      const label = `promo-archive-owner-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, futureWindow());

      const delegate = await grantRoleWith(customer, label, [
        'promotions.archive',
        'promotions.view',
      ]);
      const delegateToken = await tokenFor(delegate.email, delegate.password);
      await archivePromotion(promotionId, delegateToken);

      expect(await getPromotionRecord(promotionId, delegateToken)).toBeNull();

      // The other half of D12, and the one assertion in this file with the
      // owner as actor: he resolves discrepancies without calling support,
      // which needs both the row and the name of whoever archived it.
      const ownerToken = await tokenFor(customer.email, customer.password);
      const asOwner = await getPromotionRecord(promotionId, ownerToken);
      expect(asOwner).not.toBeNull();
      expect(asOwner?.deletedAt).not.toBeNull();
      expect(asOwner?.deletedBy).toBe(delegate.userId);
    });

    it('takes the archived promotion’s quiz out of the delegate’s reach too', async () => {
      const label = `promo-archive-quiz-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer, futureWindow());

      const ownerToken = await tokenFor(customer.email, customer.password);
      await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'Why do you listen?', options: [] },
        ownerToken,
      );

      const delegate = await grantRoleWith(customer, label, [
        'promotions.archive',
        'promotions.view',
      ]);
      const delegateToken = await tokenFor(delegate.email, delegate.password);
      const delegateClient = await signInAs(delegate.email, delegate.password);

      const before = await delegateClient
        .from('promotion_questions')
        .select('id')
        .eq('promotion_id', promotionId);
      expect(before.data ?? []).toHaveLength(1);

      await archivePromotion(promotionId, delegateToken);

      // Queried directly rather than through the record read, which would
      // return null on the promotion alone and prove nothing about the quiz.
      // This is what the `promotion_id in (select ...)` clause in 0044 buys:
      // without it the quiz outlives the promotion in this delegate's reads.
      const after = await delegateClient
        .from('promotion_questions')
        .select('id')
        .eq('promotion_id', promotionId);
      expect(after.data ?? []).toHaveLength(0);
    });
  });

  describe('the quiz', () => {
    /**
     * Block 24, D3. The Quiz tab stopped asking for a menu title and a button
     * label; `promotion_questions_list_fields` (0041) still requires both on a
     * QUIZ, and `questionOutbound` still throws without them.
     *
     * So this is the proof that removing the two inputs did not remove the two
     * values — the one thing a reviewer reading the screen diff would assume was
     * broken. It saves a question the way the screen now saves one, with neither
     * field in hand, and reads back what the door wrote.
     */
    it('writes the default menu title and button label the screen no longer collects', async () => {
      const label = `promo-quiz-defaults-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await savePromotionQuestion(
        promotionId,
        null,
        {
          kind: 'QUIZ',
          prompt: 'Which country wins?',
          options: [
            { label: 'Brazil', isCorrect: true },
            { label: 'Argentina', isCorrect: false },
          ],
        },
        token,
      );

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.questions[0]?.menuTitle).toBe(DEFAULT_QUESTION_MENU_TITLE);
      expect(record?.questions[0]?.buttonLabel).toBe(DEFAULT_QUESTION_BUTTON_LABEL);
    });

    // An ESSAY takes null for both, and must: the same constraint refuses a
    // written answer carrying either, because it shows no menu at all.
    it('leaves both null on a written answer', async () => {
      const label = `promo-quiz-essay-null-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'Why this song?', options: [] },
        token,
      );

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.questions[0]?.menuTitle).toBeNull();
      expect(record?.questions[0]?.buttonLabel).toBeNull();
    });

    /**
     * Block 24, item 5, through the service wrapper rather than the RPC. pgTAP
     * proves the door itself, including the assertion this field exists for —
     * that it writes while the promotion is frozen. What this adds is that the
     * argument actually reaches it: an RPC parameter renamed or dropped from
     * `setQuestionModerationGuidelines` type-checks perfectly and fails at
     * runtime as PGRST202, which is the trap promotionRpcArgs' own comment
     * describes.
     */
    it('writes and clears a Poll question’s moderation guidelines', async () => {
      const label = `promo-guidelines-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      const questionId = await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'Why this song?', options: [] },
        token,
      );

      await setQuestionModerationGuidelines(
        questionId,
        'Favour a memory over a review.',
        token,
      );

      const written = await getPromotionRecord(promotionId, token);
      expect(written?.questions[0]?.moderationGuidelines).toBe('Favour a memory over a review.');

      // A cleared box travels as an absence and still clears — see the service's
      // own comment for why it is `undefined` on the wire rather than null.
      await setQuestionModerationGuidelines(questionId, null, token);
      const cleared = await getPromotionRecord(promotionId, token);
      expect(cleared?.questions[0]?.moderationGuidelines).toBeNull();
    });

    it('refuses moderation guidelines without promotions.edit', async () => {
      const label = `promo-guidelines-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const editor = await grantRoleWith(customer, `${label}-editor`, ['promotions.edit']);
      const questionId = await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'Why this song?', options: [] },
        await tokenFor(editor.email, editor.password),
      );

      const reader = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(reader.email, reader.password);

      await expect(
        setQuestionModerationGuidelines(questionId, 'anything', token),
      ).rejects.toThrow(/permission/i);
    });

    it('replaces a question’s options wholesale', async () => {
      const label = `promo-quiz-replace-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      const questionId = await savePromotionQuestion(
        promotionId,
        null,
        {
          kind: 'MULTIPLE_CHOICE',
          prompt: 'Favourite genre?',
          options: [
            { label: 'Rock', isCorrect: false },
            { label: 'Samba', isCorrect: false },
          ],
        },
        token,
      );

      await savePromotionQuestion(
        promotionId,
        questionId,
        {
          kind: 'MULTIPLE_CHOICE',
          prompt: 'Favourite genre?',
          options: [
            { label: 'Forró', isCorrect: false },
            { label: 'MPB', isCorrect: false },
            { label: 'Sertanejo', isCorrect: false },
          ],
        },
        token,
      );

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.questions).toHaveLength(1);
      // The old two are gone, not merged with the new three.
      expect(record?.questions[0]?.options.map((o) => o.label)).toEqual([
        'Forró',
        'MPB',
        'Sertanejo',
      ]);
    });

    it('refuses a quiz question with no right answer marked', async () => {
      const label = `promo-quiz-nocorrect-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, ['promotions.edit']);
      const token = await tokenFor(delegate.email, delegate.password);

      // The rule no index can express: an index forbids the second right
      // answer, and nothing can require the first.
      await expect(
        savePromotionQuestion(
          promotionId,
          null,
          {
            kind: 'QUIZ',
            prompt: 'Who wins?',
            options: [
              { label: 'Brazil', isCorrect: false },
              { label: 'Argentina', isCorrect: false },
            ],
          },
          token,
        ),
      ).rejects.toThrow(/needs exactly one right answer, and 0 were marked/);
    });

    it('is refused without promotions.edit', async () => {
      const label = `promo-quiz-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, ['promotions.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(
        savePromotionQuestion(
          promotionId,
          null,
          { kind: 'ESSAY', prompt: 'Why?', options: [] },
          token,
        ),
      ).rejects.toThrow(/permission denied: promotions\.edit required/);
    });

    it('removes a question and its options, leaving the position gap', async () => {
      const label = `promo-quiz-remove-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const promotionId = await createAsOwner(customer);

      const delegate = await grantRoleWith(customer, label, [
        'promotions.edit',
        'promotions.view',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      const first = await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'First', options: [] },
        token,
      );
      await savePromotionQuestion(
        promotionId,
        null,
        { kind: 'ESSAY', prompt: 'Second', options: [] },
        token,
      );

      await removePromotionQuestion(first, token);

      const record = await getPromotionRecord(promotionId, token);
      expect(record?.questions.map((q) => q.prompt)).toEqual(['Second']);
      // Renumbering is deliberately not done: the survivor keeps position 2.
      expect(record?.questions[0]?.position).toBe(2);
    });
  });
});
