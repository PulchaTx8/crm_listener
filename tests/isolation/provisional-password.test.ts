import { describe, it, expect, afterAll } from 'vitest';
import { provisionCustomer, signInAs, cleanupUsers, admin } from './harness';

afterAll(async () => {
  await cleanupUsers();
});

describe('provisional password', () => {
  it('is set with a seven-day expiry at provisioning', async () => {
    const a = await provisionCustomer(`exp-${Date.now()}`);

    const { data } = await admin
      .from('profiles')
      .select('must_change_password, provisional_expires_at')
      .eq('id', a.userId)
      .single();

    expect(data?.must_change_password).toBe(true);
    expect(data?.provisional_expires_at).not.toBeNull();

    const days = (Date.parse(data!.provisional_expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('cannot be reset by an ordinary user', async () => {
    const a = await provisionCustomer(`reset-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    const { error } = await clientA.rpc('reset_provisional_password', {
      p_user_id: a.userId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('is reset by a platform admin, restarting the clock', async () => {
    const a = await provisionCustomer(`regen-${Date.now()}`);

    // Age the password past its expiry, as the middleware would find it.
    await admin
      .from('profiles')
      .update({ provisional_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', a.userId);

    const { error } = await a.adminClient.rpc('reset_provisional_password', {
      p_user_id: a.userId,
    });
    expect(error).toBeNull();

    const { data } = await admin
      .from('profiles')
      .select('must_change_password, provisional_expires_at')
      .eq('id', a.userId)
      .single();

    expect(data?.must_change_password).toBe(true);
    expect(Date.parse(data!.provisional_expires_at!)).toBeGreaterThan(Date.now());
  });

  it('records the reset in the audit trail', async () => {
    const a = await provisionCustomer(`audit-${Date.now()}`);
    await a.adminClient.rpc('reset_provisional_password', { p_user_id: a.userId });

    const { data } = await admin
      .from('audit_logs')
      .select('action, target_id')
      .eq('action', 'reset_provisional_password')
      .eq('target_id', a.userId);

    expect((data ?? []).length).toBe(1);
  });
});
