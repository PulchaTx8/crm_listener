import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvitationSchema } from '@/schemas/invitations';
import { acceptInvitation, validateInvitation } from '@/services/invitations';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'Please check the fields and try again.',
  short: 'The password must be at least 10 characters.',
  mismatch: 'The two passwords do not match.',
  failed: 'Could not complete the invitation. Please ask for a new one.',
};

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;

  const preview = await validateInvitation(token);

  // One message for unknown, revoked, accepted and expired alike. Three distinct
  // ones would tell an attacker which guess landed close.
  if (!preview) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <h1 className="text-xl font-semibold tracking-tight">This invitation is not valid</h1>
          <p className="text-sm text-muted-foreground">
            The link may have expired, been revoked, or already been used. Please ask whoever
            invited you to send a new one.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function accept(formData: FormData) {
    'use server';
    const parsed = acceptInvitationSchema.safeParse({
      token,
      fullName: formData.get('fullName') || undefined,
      password: String(formData.get('password') ?? ''),
      confirm: String(formData.get('confirm') ?? ''),
    });

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.path.includes('confirm')
        ? 'mismatch'
        : issue?.path.includes('password')
          ? 'short'
          : 'invalid';
      redirect(`/invite/${token}?error=${code}` as Route);
    }

    const headerList = await headers();
    const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    // redirect() signals by throwing, so the success path stays outside the
    // catch — inside, a successful acceptance would be reported as a failure.
    let destination: Route = '/login?invited=1';
    try {
      await acceptInvitation(parsed.data, ip);
    } catch (cause) {
      logger.error({ err: cause }, 'invitation acceptance failed');
      destination = `/invite/${token}?error=failed` as Route;
    }
    redirect(destination);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Join {preview.organizationName}</h1>
          <p className="text-sm text-muted-foreground">
            You were invited as <strong>{preview.role}</strong> using{' '}
            <strong>{preview.email}</strong>. Choose a password to create your account.
          </p>
        </div>
        {query.error ? (
          <p className="text-sm text-destructive">{MESSAGES[query.error] ?? MESSAGES.failed}</p>
        ) : null}
        <form action={accept} className="flex flex-col gap-4">
          <Input name="fullName" placeholder="Your name (optional)" />
          <Input name="password" type="password" placeholder="Choose a password" required />
          <Input name="confirm" type="password" placeholder="Repeat the password" required />
          <Button type="submit">Create my account</Button>
        </form>
      </CardContent>
    </Card>
  );
}
