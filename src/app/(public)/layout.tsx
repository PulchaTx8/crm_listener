export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-screen max-w-3xl px-6 py-16">{children}</div>;
}
