import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;

  async function request(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const supabase = await createUserClient();

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/auth/callback?next=/change-password`,
    });

    // Always report success. Revealing whether an address exists would let an
    // attacker enumerate customers (spec §9).
    redirect('/forgot-password?sent=1');
  }

  if (params.sent) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Check your inbox</h1>
        <p className="text-muted-foreground">
          If that address belongs to an account, we sent a link to reset the password.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <form action={request} className="flex flex-col gap-4">
        <input
          name="email"
          type="email"
          placeholder="E-mail"
          required
          className="rounded-md border p-2"
        />
        <Button type="submit">Send the link</Button>
      </form>
    </main>
  );
}
