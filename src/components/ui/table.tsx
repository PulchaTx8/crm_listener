import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { cn } from '@/lib/utils';

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    // The wrapper, not the page body, is what scrolls when the columns are wider
    // than the viewport.
    <div className="w-full overflow-x-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn('border-b transition-colors hover:bg-accent/40', className)}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

/**
 * A header cell. Forwards `aria-sort` (`'ascending' | 'descending' | 'none'`)
 * through `...props` — nothing here sets it. Screens that render a sortable
 * column with `SortLink` should set `aria-sort` on the `TableHead` that
 * wraps it, so assistive technology gets the sort state at the cell level
 * too, not only from the visually-hidden text `SortLink` itself renders.
 */
export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-3 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';

/**
 * Renders a `div`, not a `<tfoot>` — unlike `TableHeader`/`TableBody`, whose
 * names match a real table section, this one doesn't. Only place it (directly,
 * or via `PageControls`) outside `Table`/below its `overflow-x-auto` wrapper,
 * never as a child of `Table` itself: a `div` inside a `table` is invalid
 * HTML, gets foster-parented out of the table by the browser, and risks a
 * hydration mismatch.
 */
export const TableFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t px-3 py-3 text-sm',
        className,
      )}
      {...props}
    />
  ),
);
TableFooter.displayName = 'TableFooter';

/** A column header that toggles the sort by rewriting the URL. */
export function SortLink({
  href,
  active,
  direction,
  children,
}: {
  href: string;
  active: boolean;
  direction: 'asc' | 'desc';
  children: React.ReactNode;
}) {
  const stateLabel = active
    ? `, sorted ${direction === 'desc' ? 'descending' : 'ascending'}`
    : ', not sorted';

  return (
    <Link
      // typedRoutes cannot express a URL assembled at runtime (sort/cursor
      // query params) as a route literal, so this casts to Route — the same
      // pattern member-search-form.tsx uses for the same reason.
      href={href as Route}
      className="inline-flex items-center gap-1 ring-offset-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
      {/* Visually hidden so the sort state reaches a screen reader even if the
          caller never sets `aria-sort` on the enclosing TableHead. */}
      <span className="sr-only">{stateLabel}</span>
      <span aria-hidden="true" className={cn('text-[0.65rem]', active ? '' : 'opacity-30')}>
        {active && direction === 'desc' ? '▼' : '▲'}
      </span>
    </Link>
  );
}

/**
 * Previous/Next, never page numbers: keyset pagination can move one page in
 * either direction at constant cost, but cannot jump to an arbitrary page.
 *
 * `total` is omitted on the platform-wide admin screens, where counting is not
 * cheap and nobody is asking "how many".
 */
export function PageControls({
  total,
  label,
  previousHref,
  nextHref,
}: {
  total?: number | null;
  label: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  return (
    <TableFooter>
      <span className="text-muted-foreground" data-testid="page-total">
        {typeof total === 'number' ? `${total.toLocaleString('en-GB')} ${label}` : label}
      </span>
      <span className="flex items-center gap-2">
        {previousHref ? (
          <Link
            href={previousHref as Route}
            data-testid="page-previous"
            className="rounded-md border px-3 py-1.5 ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Previous
          </Link>
        ) : (
          // A disabled button, not inert text dressed as a control: it is
          // announced as a control that exists but cannot be used right now,
          // where a plain span with no role would read as ordinary text.
          <button
            type="button"
            disabled
            data-testid="page-previous"
            className="rounded-md border px-3 py-1.5 opacity-40 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Previous
          </button>
        )}
        {nextHref ? (
          <Link
            href={nextHref as Route}
            data-testid="page-next"
            className="rounded-md border px-3 py-1.5 ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Next
          </Link>
        ) : (
          <button
            type="button"
            disabled
            data-testid="page-next"
            className="rounded-md border px-3 py-1.5 opacity-40 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Next
          </button>
        )}
      </span>
    </TableFooter>
  );
}
