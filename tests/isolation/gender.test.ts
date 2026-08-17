import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * The gender block, through a real door with a real session.
 *
 * WHAT 63_gender.test.sql CANNOT SEE, which is why this file exists beside it.
 * pgTAP runs as superuser with a null `auth.uid()`, so `has_permission` answers
 * true unconditionally and every gate reads open; it can assert that the grant
 * on `create_member`/`update_member` EXISTS after the drop-and-recreate, and it
 * cannot assert that a caller who is not the Organization owner can actually
 * make the call. That distinction is the whole risk of this block's Task 2: both
 * doors were dropped to take one more argument, a dropped function takes its ACL
 * with it, and the owner bypass means the one identity most tests use would
 * never notice its absence.
 *
 * AND THE WRITE PATH IS NOT DIRECTLY REACHABLE. `apply_member_field_values` and
 * `gender_normalize` are granted to nobody — they are called from inside other
 * functions — so the only way to exercise the resolver end to end from a session
 * is through a door that uses it. `update_member` is that door, and the cases
 * below drive the resolver through it rather than calling it, which is also what
 * makes them a test of the WIRING and not of the SQL function pgTAP already
 * covers directly.
 */
const STAMP = Date.now();

describe('the gender block — the column, through the doors', () => {
  let customer: ProvisionedCustomer;
  let memberId: string;
  let editor: { email: string; password: string };
  let reader: { email: string; password: string };

  beforeAll(async () => {
    customer = await provisionCustomer(`gender-${STAMP}`);
    memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Gender Listener ${STAMP}`,
      phone: `+55419${String(STAMP).slice(-8)}`,
    });
    editor = await grantRoleWith(customer, `gender-editor-${STAMP}`, [
      'members.view',
      'members.edit',
    ]);
    reader = await grantRoleWith(customer, `gender-reader-${STAMP}`, ['members.view']);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  /** What the column actually holds right now, read past RLS. */
  async function stored(): Promise<string | null> {
    const { data, error } = await admin.from('members').select('gender').eq('id', memberId).single();
    expect(error).toBeNull();
    return data?.gender ?? null;
  }

  /** The one door that reaches the resolver, called as a delegate. */
  async function saveAs(
    who: { email: string; password: string },
    gender: string | undefined,
  ): Promise<{ code?: string; message?: string }> {
    const client = await signInAs(who.email, who.password);
    const { error } = await client.rpc('update_member', {
      p_member_id: memberId,
      p_full_name: `Gender Listener ${STAMP}`,
      p_gender: gender,
    });
    return { code: error?.code, message: error?.message };
  }

  // -------------------------------------------------------------------------
  // 1. THE ACL, proved by a caller who is not the owner.
  // -------------------------------------------------------------------------
  it('lets a delegate holding members.edit save a code through the recreated door', async () => {
    const result = await saveAs(editor, 'F');
    expect(result.code, result.message).toBeUndefined();
    expect(await stored()).toBe('F');
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. The resolver, IN THE PATH rather than beside it.
  // -------------------------------------------------------------------------
  it('resolves prose an operator pasted in, so the column holds one spelling', async () => {
    // Not a test of gender_normalize — 63_gender.test.sql calls that directly.
    // This is a test that update_member ROUTES THROUGH IT. A door that wrote
    // p_gender straight into the column would pass every pgTAP case in this
    // block and fail here with a 23514, or worse, store 'masculino' beside
    // somebody else's 'M' and split one audience into two.
    const result = await saveAs(editor, 'masculino');
    expect(result.code, result.message).toBeUndefined();
    expect(await stored()).toBe('M');
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. THE RULE THE WHOLE DESIGN TURNS ON, at the operator door.
  // -------------------------------------------------------------------------
  it('accepts a value it cannot resolve, recording no gender rather than refusing the save', async () => {
    // 0213's sentence, applied to the tenth field: an unrecognised answer must
    // cost the answer, never the write. A door that raised here would refuse an
    // operator's whole edit — name, phone, address and all — over one select
    // somebody typed into.
    const result = await saveAs(editor, 'banana');
    expect(result.code, result.message).toBeUndefined();
    expect(await stored()).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. Clearing, which is why 'N' is a code and not the empty selection.
  // -------------------------------------------------------------------------
  it('clears the column when the form posts nothing, without that meaning "declined"', async () => {
    await saveAs(editor, 'N');
    expect(await stored(), 'the decline is storable').toBe('N');

    const result = await saveAs(editor, undefined);
    expect(result.code, result.message).toBeUndefined();
    // Back to the fourth state — "nobody asked" — which is a different thing
    // from 'N'. If the blank selection had been spelled as the decline, an
    // operator undoing a mistake would have recorded a refusal instead.
    expect(await stored()).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. The gate still holds after the drop and recreate.
  // -------------------------------------------------------------------------
  it('refuses a delegate who may see listeners but not edit them', async () => {
    const result = await saveAs(reader, 'M');
    expect(result.code).toBe('42501');
    expect(await stored()).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 6. Erasure reaches it.
  // -------------------------------------------------------------------------
  it('is cleared by an erasure, like every other fact about the person', async () => {
    await saveAs(editor, 'F');
    expect(await stored()).toBe('F');

    const eraser = await grantRoleWith(customer, `gender-eraser-${STAMP}`, [
      'members.view',
      'members.erase',
    ]);
    const client = await signInAs(eraser.email, eraser.password);
    const { error } = await client.rpc('anonymize_member', {
      p_member_id: memberId,
      p_reason: 'subject_request',
    });
    expect(error?.message).toBeUndefined();
    expect(await stored()).toBeNull();
  }, 120_000);
});
