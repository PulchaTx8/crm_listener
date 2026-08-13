import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
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
    // /app. The middleware still enforces both rules for every other request.
    redirect(profile?.must_change_password ? '/change-password' : '/app');
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

      {/* The two documents somebody is agreeing to, on the screen where they
          agree — and the only place in the signed-out product that names them,
          since the (public) header renders on the legal pages themselves and
          nowhere else. Meta also asks for these two addresses to be reachable
          before it will review the WhatsApp integration (docs/DEPLOYMENT.md
          §11).

          RICH TEXT rather than three concatenated fragments. The links sit in
          the middle of a sentence whose word order differs in all three
          languages — Portuguese and Spanish put the product name last, English
          does not — and a sentence assembled from pieces is grammatical in
          exactly one of them.

          The product name is interpolated from `pulchatx` rather than written
          into the three strings, so the wordmark above and this line can never
          come to spell it differently. */}
      <p className="text-center text-xs text-muted-foreground">
        {t.rich('bySigningInYouAgreeTo', {
          brand: t('pulchatx'),
          terms: (chunks) => (
            <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
