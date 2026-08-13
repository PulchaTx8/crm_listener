import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { MEMBER_HOME } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string }>;
}) {
  const t = await getTranslations('auth');
  const params = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    // Deliberately generic: a distinct "no such user" message would let an
    // attacker enumerate accounts (spec §9).
    if (error || !data.user) redirect('/login?error=1');

    const { data: profile } = await supabase
      .from('profiles')
      .select('must_change_password, provisional_expires_at')
      .eq('id', data.user.id)
      .single();

    const expiresAt = profile?.provisional_expires_at;
    if (profile?.must_change_password && expiresAt && Date.parse(expiresAt) <= Date.now()) {
      await supabase.auth.signOut();
      redirect('/login?error=expired');
    }

    // Chosen here rather than left to the middleware. A middleware redirect
    // issued during a Server Action's RSC navigation leaves the address bar on
    // the old path, so the customer would see /change-password while looking at
    // MEMBER_HOME. The middleware still enforces both rules for every other
    // request.
    redirect(profile?.must_change_password ? '/change-password' : MEMBER_HOME);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('accessYourAccount')}</h1>

      {params.invited ? (
        <p className="text-sm text-muted-foreground">{t('yourAccountIsReadySignIn')}</p>
      ) : null}
      {params.error ? (
        <p className="text-sm text-destructive">
          {params.error === 'expired'
            ? t('yourProvisionalPasswordHasExpired')
            : t('invalidCredentials')}
        </p>
      ) : null}

      <form action={signIn} className="flex flex-col gap-4">
        {/* VISIBLE LABELS, and no placeholder repeating them. A placeholder is
            the field's only description until the first keystroke and nothing
            at all after it, which is the state a field spends its whole life
            in. `htmlFor`/`id` rather than wrapping: the password field renders
            its own <div> for the reveal button, so a wrapping label would take
            the button's click as a click on the input. */}
        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-sm font-medium">
            {t('eMail')}
          </label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-sm font-medium">
            {t('password')}
          </label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </div>

        <Link href="/forgot-password" className="self-start text-sm text-primary hover:underline">
          {t('forgotYourPassword')}
        </Link>

        <Button type="submit" className="mt-2 w-full">
          {t('signIn')}
        </Button>
      </form>
    </div>
  );
}
