import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * Block 12a. The language a person may set is their own, and only their own.
 *
 * `27_profile_locale.test.sql` asserts the GRANT exists; only this file can
 * assert the POLICY, because pgTAP runs as superuser with a null auth.uid() and
 * never exercises RLS at all.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const mineEmail = `locale-mine-${stamp}@example.test`;
const theirsEmail = `locale-theirs-${stamp}@example.test`;
const password = `Locale-${stamp}-pw`;

let mine: SupabaseClient;
let mineId = '';
let theirsId = '';

async function makeUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  const profile = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profile.error) throw new Error(`profile ${email}: ${profile.error.message}`);
  return data.user.id;
}

beforeAll(async () => {
  mineId = await makeUser(mineEmail);
  theirsId = await makeUser(theirsEmail);

  mine = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await mine.auth.signInWithPassword({ email: mineEmail, password });
  if (error) throw new Error(`sign in: ${error.message}`);
}, 60_000);

describe('Block 12a — the interface language is the reader’s own', () => {
  it('a signed-in caller sets their own language', async () => {
    const { error } = await mine.from('profiles').update({ locale: 'pt' }).eq('id', mineId);
    expect(error, error?.message).toBeNull();

    // Read back with the service key rather than trusting the absence of an
    // error: RLS refuses by matching no row, which is not an error.
    const { data } = await admin.from('profiles').select('locale').eq('id', mineId).single();
    expect(data?.locale).toBe('pt');
  }, 60_000);

  it('and cannot set anybody else’s', async () => {
    // profiles_update_self (0006) answers this, not the application. The write
    // matches no row rather than raising, so the assertion is on the OTHER
    // row's value -- a silent no-op is precisely the failure mode.
    await mine.from('profiles').update({ locale: 'es' }).eq('id', theirsId);

    const { data } = await admin.from('profiles').select('locale').eq('id', theirsId).single();
    expect(data?.locale, 'one account changed another account’s language').toBeNull();
  }, 60_000);

  it('and cannot smuggle another column in beside it', async () => {
    // The grant is column-scoped (0135). must_change_password gates the
    // account, and the account it gates does not get to write it.
    const { error } = await mine
      .from('profiles')
      .update({ locale: 'es', must_change_password: false })
      .eq('id', mineId);

    expect(error, 'a column-scoped grant let an ungranted column through').not.toBeNull();
  }, 60_000);
});
