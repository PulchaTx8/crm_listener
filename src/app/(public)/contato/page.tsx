import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { contactRequestSchema } from '@/schemas/contact';
import { submitContactRequest } from '@/services/contact-requests';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;

  async function submit(formData: FormData) {
    'use server';
    const parsed = contactRequestSchema.safeParse({
      name: formData.get('name'),
      email: formData.get('email'),
      phone: formData.get('phone') || undefined,
      companyName: formData.get('companyName') || undefined,
      message: formData.get('message') || undefined,
    });

    if (!parsed.success) redirect('/contato?error=invalid');

    const headerList = await headers();
    const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    // redirect() signals by throwing, so it must sit outside the catch —
    // inside, a successful submission would be reported as a failure.
    let destination: Route = '/contato?sent=1';
    try {
      await submitContactRequest(parsed.data, ip);
    } catch (cause) {
      // The visitor gets a deliberately vague sentence; the operator needs the
      // real one. Swallowing the cause here left a production failure with no
      // server-side trace at all, and the only way to diagnose it was to
      // reproduce the insert by hand against both databases.
      logger.error({ err: cause }, 'contact request submission failed');
      destination = '/contato?error=failed';
    }
    redirect(destination);
  }

  if (params.sent) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Thank you</h1>
        <p className="text-muted-foreground">We received your message and will be in touch.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Get in touch</h1>
      {params.error ? (
        <p className="text-sm text-destructive">
          {params.error === 'invalid'
            ? 'Please check the fields and try again.'
            : 'Something went wrong. Please try again later.'}
        </p>
      ) : null}
      <form action={submit} className="flex flex-col gap-4">
        <Input name="name" placeholder="Your name" required />
        <Input name="email" type="email" placeholder="E-mail" required />
        <Input name="phone" placeholder="Phone (optional)" />
        <Input name="companyName" placeholder="Company (optional)" />
        <Textarea name="message" placeholder="How can we help?" rows={4} />
        <Button type="submit">Send</Button>
      </form>
    </main>
  );
}
