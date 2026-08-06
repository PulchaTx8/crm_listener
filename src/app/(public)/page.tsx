import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

/**
 * Block 11b, D1. Rendered per request so the CSP nonce exists at render time.
 *
 * `next build` prerendered this page, and prerendered HTML carries no request
 * nonce -- so Next's inline bootstrap scripts shipped unstamped and the policy
 * blocked every one of them. Nothing hydrates, and nothing says why: the
 * violations are raised in the browser, which is exactly how Block 11a lost
 * three days. This was the ONLY route in the application still static.
 *
 * The cost is rendering a page of static markup per request, which this product
 * will never notice.
 */
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar text-sidebar-accent-foreground">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M12 12h.01M7.05 16.95a7 7 0 0 1 0-9.9M16.95 7.05a7 7 0 0 1 0 9.9M4.22 19.78a11 11 0 0 1 0-15.56M19.78 4.22a11 11 0 0 1 0 15.56" />
          </svg>
        </span>
        <span className="text-lg font-semibold">PulchatX</span>
      </div>

      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">PulchatX</h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          CRM for entertainment companies. Manage your audience relationship and the whole prize
          distribution cycle of your promotions.
        </p>
        <p className="max-w-xl text-muted-foreground">
          PulchatX is sold by subscription. Get in touch and we will set your account up.
        </p>
      </div>

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
