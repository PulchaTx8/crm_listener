import { z } from 'zod';

/**
 * The inventory list's category filter value meaning "belongs to no category
 * at all". Not a uuid, so it can never collide with a real category id.
 *
 * It lives here rather than in services/inventory.ts because both sides need
 * it and one of them is a client component: the service compares against it
 * when building the query, and inventory-filters.tsx renders it as an option
 * value. A `server-only` module cannot be imported from a client component,
 * and two copies of a sentinel is exactly how one of them drifts.
 */
export const UNCATEGORISED_FILTER = 'uncategorised';

// Mirrors 0027_inventory_rpcs.sql's create_prize/update_prize: both take the
// same catalogue fields. update_prize resolves the Organization AND the
// Company from the prize row itself (never a parameter), so companyId here
// is only consumed by the caller when creating, not when updating.
export const prizeFormSchema = z.object({
  companyId: z.string().uuid(),
  categoryId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? undefined : v)),
  name: z.string().trim().min(1, 'Name the prize.').max(120),
  // internal_code is optional but bounded: create_prize/update_prize store it
  // as `text` with no length limit of its own, so leaving this unbounded
  // would let the form accept a value the database happily stores but no
  // screen — the prize list, the internal-code search — could display or
  // compare sensibly. 40 characters comfortably covers a SKU or barcode.
  internalCode: z
    .string()
    .trim()
    .max(40, 'Keep the internal code to 40 characters or fewer.')
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v)),
  description: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v)),
  allowsReturnToStock: z.boolean(),
});

export type PrizeFormInput = z.infer<typeof prizeFormSchema>;

// Every quantity in 0026/0027 is a positive whole number — the ledger's own
// `check (quantity > 0)` and apply_inventory_movement's `p_quantity <= 0`
// guard both refuse zero, a negative figure and (being an integer column) a
// fractional one. Validating it here turns that 22023 into a field-level
// message instead of a round trip.
const quantity = z
  .number()
  .int('Quantity must be a whole number.')
  .positive('Quantity must be greater than zero.');

// Every mandatory note in 0027 is passed through
// nullif(trim(coalesce(p_note, '')), '') before the RPC's own null check, so
// whitespace-only is refused there exactly as if the note were absent.
// Trimming here gives the same verdict without a round trip.
const mandatoryNote = z.string().trim().min(1, 'A note is required.');

const optionalNote = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

// adjust_stock takes the counted figure, not a delta (0027's own comment: a
// person reconciling with a shelf counts what is there). Zero is a real,
// legal count — nothing on the shelf — so only negative and fractional
// figures are refused.
const countedFigure = z
  .number()
  .int('The counted figure must be a whole number.')
  .min(0, 'The counted figure cannot be negative.');

const idempotencyKey = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

const movementBase = {
  companyId: z.string().uuid(),
  prizeId: z.string().uuid(),
  idempotencyKey,
};

// One variant per movement RPC's actual shape, discriminated on `kind` so the
// type narrows to exactly the fields that RPC takes. record_stock_entry is
// the only one of the five with an optional note (0027's own comment: "an
// entry rarely needs explaining, unlike an exit, an adjustment or a
// reservation"); every other movement's note is mandatory. adjust_stock is
// the only variant with a `counted` figure instead of a `quantity` delta.
export const movementFormSchema = z.discriminatedUnion('kind', [
  z.object({
    ...movementBase,
    kind: z.literal('entry'),
    entryType: z.enum(['INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY']),
    quantity,
    note: optionalNote,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('exit'),
    quantity,
    note: mandatoryNote,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('reserve'),
    quantity,
    note: mandatoryNote,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('release'),
    quantity,
    note: mandatoryNote,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('adjustment'),
    counted: countedFigure,
    note: mandatoryNote,
  }),
]);

export type MovementFormInput = z.infer<typeof movementFormSchema>;
