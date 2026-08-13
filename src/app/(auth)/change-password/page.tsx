import { getTranslations } from 'next-intl/server';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

// The `?error=` codes this page answers, as catalogue keys — a module body has
// no request behind it, so it has no language either.
const MESSAGE_KEYS: Record<string, string> = {
  short: 'thePasswordMustBeAtLeast10',
  mismatch: 'theTwoPasswordsDoNotMatch',
  failed: 'couldNotChangeThePassword',
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('auth');
  const params = await searchParams;

  async function change(formData: FormData) {
    'use server';
    const password = String(formData.get('password') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    // Mirrors minimum_password_length in supabase/config.toml.
    if (password.length < 10) redirect('/change-password?error=short');
    if (password !== confirm) redirect('/change-password?error=mismatch');

    const supabase = await createUserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) redirect('/change-password?error=failed');

    // Only now is the gate cleared, and only by the SECURITY DEFINER function —
    // the columns are not writable from a client.
    const { error: rpcError } = await supabase.rpc('complete_password_change');
    if (rpcError) redirect('/change-password?error=failed');

    redirect('/app' as Route);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <h1 className="text-xl font-semibold tracking-tight">{t('chooseANewPassword')}</h1>
        <p className="text-muted-foreground">
          {t('yourAccountWasCreatedWithA')}</p>
        {params.error ? (
          <p className="text-sm text-destructive">{t((params.error && MESSAGE_KEYS[params.error]) || 'couldNotChangeThePassword')}</p>
        ) : null}
        <form action={change} className="flex flex-col gap-4">
          <Input name="password" type="password" placeholder={t('newPassword')} required />
          <Input name="confirm" type="password" placeholder={t('repeatThePassword')} required />
          <Button type="submit">{t('save')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
