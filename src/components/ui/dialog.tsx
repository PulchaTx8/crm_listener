'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A modal built on the native `<dialog>`. `showModal()` is what supplies focus
 * trapping, the inert backdrop, the top layer and ESC — none of which is
 * reimplemented here, because a hand-rolled focus trap is the part of a dialog
 * that rots first and the part nobody re-tests.
 *
 * Three behaviours ARE ours, and only three:
 *
 *   - dismissing on a backdrop click, which the element does not do by itself;
 *   - returning focus to whatever opened it — the browser restores focus only
 *     when the dialog closes through its own `form method="dialog"`, and every
 *     closing path here is ours;
 *   - routing ESC through `onClose` rather than letting it close directly, so a
 *     caller holding unsaved edits can ask before discarding them.
 */
export const Dialog = React.forwardRef<
  HTMLDialogElement,
  {
    open: boolean;
    onClose: () => void;
    /** id of the element naming this dialog, for aria-labelledby. */
    labelledBy: string;
    className?: string;
    children: React.ReactNode;
  }
>(({ open, onClose, labelledBy, className, children }, forwardedRef) => {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useImperativeHandle(forwardedRef, () => ref.current as HTMLDialogElement);

  // Whatever had focus when the dialog opened, so it can be handed back.
  const opener = React.useRef<Element | null>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = document.activeElement;
      node.showModal();
    }
    if (!open && node.open) {
      node.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        // ESC. Prevented so the caller decides what happens — it may need to
        // confirm before discarding what was typed.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click landing on the dialog element itself, rather than on any of
        // its children, is a click on the backdrop.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-full max-w-3xl rounded-lg border bg-background p-0 text-foreground shadow-lg',
        'backdrop:bg-black/50',
        // A full-height sheet on a narrow viewport; a centred box above it.
        'max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none',
        className,
      )}
    >
      {/* Rendered only while open, so its content never lingers in the DOM and
          each opening starts from a fresh mount. */}
      {open ? (
        <div className="flex max-h-[85dvh] flex-col max-sm:h-full max-sm:max-h-none">{children}</div>
      ) : null}
    </dialog>
  );
});
Dialog.displayName = 'Dialog';

export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-start justify-between gap-4 border-b px-5 py-4', className)}
      {...props}
    />
  ),
);
DialogHeader.displayName = 'DialogHeader';

export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2 ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

/** The scrolling region: the header and footer stay put while this moves. */
export const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
  ),
);
DialogBody.displayName = 'DialogBody';

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3', className)}
      {...props}
    />
  ),
);
DialogFooter.displayName = 'DialogFooter';
