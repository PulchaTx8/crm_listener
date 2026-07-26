import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PulchatX',
  description: 'CRM for entertainment companies',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
