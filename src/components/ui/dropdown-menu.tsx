'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A small menu for a grid row's actions. Not a general menu system: one
 * trigger, a flat list of items, keyboard and dismissal handled correctly.
 *
 * `label` names the trigger for assistive technology. An icon-only control
 * says nothing without it — the finding this project's table primitive already
 * shipped once and had corrected in review.
 */
export function DropdownMenu({
  trigger,
  label,
  children,
}: {
  trigger: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          // Closing on an item's activation lives here rather than in each
          // item, so a caller cannot forget it.
          onClick={() => setOpen(false)}
          className="absolute right-0 z-20 mt-1 min-w-56 rounded-md border bg-background py-1 text-left shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DropdownMenuItem({
  onSelect,
  destructive,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'block w-full px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        destructive && 'text-destructive',
      )}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div role="separator" className="my-1 border-t" />;
}
