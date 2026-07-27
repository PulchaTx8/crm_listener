import Link from 'next/link';

/**
 * Sign-in, password reset and the forced password change. Deliberately outside
 * the application shell: someone held at the password gate should not be shown
 * a navigation they cannot use.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <Link href="/" className="mb-8 flex items-center gap-2">
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
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
