import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">PulchatX</h1>
      <p className="text-muted-foreground">
        CRM for entertainment companies. Manage your audience relationship and the whole prize
        distribution cycle of your promotions.
      </p>
      <p className="text-muted-foreground">
        PulchatX is sold by subscription. Get in touch and we will set your account up.
      </p>
      <div className="flex gap-3">
        {/* Button has no asChild and the plan rules out adding Radix Slot for it,
            so the link carries the button styling directly. */}
        <Link href="/contato" className={buttonVariants()}>
          Get in touch
        </Link>
        <Link href="/login" className={buttonVariants({ variant: 'outline' })}>
          Sign in
        </Link>
      </div>
    </main>
  );
}
