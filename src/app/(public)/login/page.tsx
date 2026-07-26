import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const supabase = await createUserClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    // Deliberately generic: a distinct "no such user" message would let an
    // attacker enumerate accounts (spec §9).
    if (error) redirect('/login?error=1');
    // Safe for everyone: the middleware bounces users who do not need the
    // change screen straight to /app.
    redirect('/change-password');
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {params.error ? (
        <p className="text-sm text-destructive">
          {params.error === 'expired'
            ? 'Your provisional password has expired. Please contact us for a new one.'
            : 'Invalid credentials.'}
        </p>
      ) : null}
      <form action={signIn} className="flex flex-col gap-4">
        <input
          name="email"
          type="email"
          placeholder="E-mail"
          required
          className="rounded-md border p-2"
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          className="rounded-md border p-2"
        />
        <Button type="submit">Sign in</Button>
      </form>
      <Link href="/forgot-password" className="text-sm underline">
        Forgot your password?
      </Link>
    </main>
  );
}
