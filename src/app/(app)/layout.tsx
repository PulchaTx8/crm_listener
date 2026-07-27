export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-screen max-w-3xl px-6 py-12">{children}</div>;
}
