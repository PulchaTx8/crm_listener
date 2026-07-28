'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input } from '@/components/ui/input';

const DEBOUNCE_MS = 350;

/**
 * The only client boundary this screen needs — and unlike InventoryBrowser
 * (inventory/inventory-browser.tsx), which filters an already-fetched list in
 * memory, this component filters NOTHING itself. Typing here only edits the
 * page's `q` URL parameter (debounced, via router.replace), which is what
 * makes MembersPage — a Server Component — re-run with the new term and call
 * listOrganizationMembers again on the server. The audience the caller cannot
 * search into never reaches this component to begin with; what changes on
 * every keystroke is the query Postgres runs, not a `.filter()` in the
 * browser.
 */
export function MemberSearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function handleChange(next: string) {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const trimmed = next.trim();
      // typedRoutes cannot express a query string assembled at runtime as a
      // route literal, so this is one of the few places in this codebase
      // that casts to Route (sidebar-nav.tsx's own import of the same type
      // is the precedent) rather than using next/link's object-href form —
      // the destination is a hand-built query string, not a dynamic segment.
      const query = trimmed ? `?q=${encodeURIComponent(trimmed)}` : '';
      router.replace(`/members${query}` as Route);
    }, DEBOUNCE_MS);
  }

  return (
    <Input
      type="search"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder="Search by name, phone, e-mail, or the CPF's last digits"
      aria-label="Search the audience by name, phone, e-mail, or the CPF's last digits"
      className="h-10 w-full max-w-md"
      data-testid="member-search-input"
    />
  );
}
