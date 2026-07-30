'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** How far below the trigger the panel sits, in pixels. */
const GAP = 4;

/**
 * A small menu for a grid row's actions. Not a general menu system: one
 * trigger, a flat list of items, keyboard and dismissal handled correctly.
 *
 * `label` names the trigger for assistive technology. An icon-only control
 * says nothing without it — the finding this project's table primitive already
 * shipped once and had corrected in review.
 *
 * The panel is rendered through a portal, in the document body, rather than
 * positioned absolutely beside its trigger. That is not a preference: every
 * caller puts this in a table cell, and Table's own wrapper carries
 * `overflow-x-auto` so that wide columns scroll instead of the page. A
 * computed `overflow-x` of `auto` forces `overflow-y` to `auto` as well (CSS
 * Overflow 3, §3), so that wrapper clips its own descendants vertically — and
 * an absolutely positioned menu dropping below the row was simply cut off.
 * Found by opening the row menu at 390px wide during Block 3c's hand check:
 * the trigger toggled, `aria-expanded` flipped, and nothing appeared on screen.
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
  const [position, setPosition] = React.useState({ top: 0, right: 0 });
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Fixed coordinates, taken from the trigger and re-taken whenever anything
  // moves it. `position: fixed` is what escapes the scrolling wrapper; the
  // cost of leaving the trigger's coordinate space is having to follow it.
  const place = React.useCallback(() => {
    const node = triggerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPosition({
      top: rect.bottom + GAP,
      right: Math.max(GAP, window.innerWidth - rect.right),
    });
  }, []);

  React.useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // The panel is no longer inside the trigger's subtree, so dismissal has
      // to ask about both.
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    // Capture phase, so a scroll inside the table wrapper reaches this too —
    // scroll does not bubble from an element to the document.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {trigger}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            // Closing on an item's activation lives here rather than in each
            // item, so a caller cannot forget it.
            onClick={() => setOpen(false)}
            style={{ top: position.top, right: position.right }}
            className="fixed z-50 min-w-56 max-w-[calc(100vw-0.5rem)] rounded-md border bg-background py-1 text-left shadow-lg"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
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
