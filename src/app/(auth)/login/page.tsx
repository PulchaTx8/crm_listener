import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
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
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        {params.error ? (
          <p className="text-sm text-destructive">
            {params.error === 'expired'
              ? 'Your provisional password has expired. Please contact us for a new one.'
              : 'Invalid credentials.'}
          </p>
        ) : null}
        <form action={signIn} className="flex flex-col gap-4">
          <Input name="email" type="email" placeholder="E-mail" required />
          <Input name="password" type="password" placeholder="Password" required />
          <Button type="submit">Sign in</Button>
        </form>
        <Link href="/forgot-password" className="text-sm underline">
          Forgot your password?
        </Link>
      </CardContent>
    </Card>
  );
}
