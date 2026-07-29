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
  return (
    <Link
      // typedRoutes cannot express a URL assembled at runtime (sort/cursor
      // query params) as a route literal, so this casts to Route — the same
      // pattern member-search-form.tsx uses for the same reason.
      href={href as Route}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {children}
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
            className="rounded-md border px-3 py-1.5 hover:bg-accent/40"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-md border px-3 py-1.5 opacity-40">Previous</span>
        )}
        {nextHref ? (
          <Link
            href={nextHref as Route}
            data-testid="page-next"
            className="rounded-md border px-3 py-1.5 hover:bg-accent/40"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-md border px-3 py-1.5 opacity-40">Next</span>
        )}
      </span>
    </TableFooter>
  );
}
