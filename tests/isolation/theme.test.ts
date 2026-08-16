import { afterAll, describe, expect, it } from 'vitest';
import { cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 25, D5. What pgTAP cannot reach.
 *
 * `55_profile_theme.test.sql` asserts the column-scoped grant EXISTS. Only a
 * real JWT can prove what the grant plus `profiles`' own RLS actually add up to,
 * because pgTAP runs as a superuser with a null `auth.uid()` where the policy
 * never applies at all — which for this column is the whole question: the grant
 * says "an authenticated role may write this column", and the policy is what
 * says "of their own row".
 *
 * The quiet failure is the one this file is really for. RLS refuses by matching
 * NO ROW rather than by raising, so a colleague's theme being unwritable and a
 * colleague's theme being silently rewritten look identical to any caller that
 * checks `error` alone. That is why `setThemeAction` reads the row back, and why
 * the second case below reads the victim's row rather than trusting the verdict.
 */
describe('the theme column', () => {
  it('lets a member write their own theme, and read it back', async () => {
    const label = `theme-own-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const member = await grantRoleWith(customer, label, ['members.view']);
    const client = await signInAs(member.email, member.password);

    const written = await client
      .from('profiles')
      .update({ theme: 'dark' })
      .eq('id', member.userId)
      .select('theme')
      .maybeSingle();

    expect(written.error).toBeNull();
    expect(written.data?.theme).toBe('dark');

    // System is a deletion rather than a value, and NULL has to be writable for
    // that: a check constraint naming only 'light' and 'dark' would still be
    // satisfied by a column nobody may set to null.
    const cleared = await client
      .from('profiles')
      .update({ theme: null })
      .eq('id', member.userId)
      .select('theme')
      .maybeSingle();

    expect(cleared.error).toBeNull();
    expect(cleared.data?.theme).toBeNull();
  });

  it('refuses a theme the check constraint does not name', async () => {
    const label = `theme-junk-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const member = await grantRoleWith(customer, label, ['members.view']);
    const client = await signInAs(member.email, member.password);

    // 'system' most of all: it is the one wrong value somebody would plausibly
    // write, because it IS one of the three the menu offers.
    const attempt = await client
      .from('profiles')
      .update({ theme: 'system' })
      .eq('id', member.userId);

    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.code).toBe('23514');
  });

  it('cannot write a colleague’s theme, and leaves it as it was', async () => {
    const label = `theme-other-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const victim = await grantRoleWith(customer, `${label}-victim`, ['members.view']);
    const meddler = await grantRoleWith(customer, `${label}-meddler`, ['members.view']);

    // The victim chooses first, so the assertion below is about the value
    // SURVIVING rather than about it never having existed.
    const victimClient = await signInAs(victim.email, victim.password);
    await victimClient.from('profiles').update({ theme: 'light' }).eq('id', victim.userId);

    const meddlerClient = await signInAs(meddler.email, meddler.password);
    const attempt = await meddlerClient
      .from('profiles')
      .update({ theme: 'dark' })
      .eq('id', victim.userId)
      .select('theme');

    // NO ERROR AND NO ROW — the shape of every RLS refusal, and the reason
    // checking `error` alone would call this a success.
    expect(attempt.error).toBeNull();
    expect(attempt.data ?? []).toHaveLength(0);

    const after = await victimClient
      .from('profiles')
      .select('theme')
      .eq('id', victim.userId)
      .maybeSingle();
    expect(after.data?.theme).toBe('light');
  });

  /**
   * The negative half of D5, driven rather than read off the catalogue.
   * `55_profile_theme.test.sql` asserts `has_column_privilege` is false for
   * `must_change_password`; this asserts what that means when somebody tries —
   * because a blanket `grant update on public.profiles` would fix the theme and
   * hand the account's own gate to the account.
   */
  it('still cannot write the columns that gate the account', async () => {
    const label = `theme-gate-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const member = await grantRoleWith(customer, label, ['members.view']);
    const client = await signInAs(member.email, member.password);

    const attempt = await client
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', member.userId);

    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.code).toBe('42501');
  });
});
