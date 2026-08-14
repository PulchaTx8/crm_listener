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

// Block 23, Task 4 fix round 1 (I4): every field below was, until this
// round, only a TypeScript intersection bolted onto services/inventory.ts's
// own Stock*Input types — never part of movementFormSchema itself.
// movementFormSchema's discriminatedUnion is a plain z.object per variant,
// with no .strict(), so Zod's default behaviour is to STRIP any key not
// named in the schema. A form built against the intersection type would
// still typecheck (every added field was optional), post an object carrying
// invoiceNumber/unitAmount/totalAmount/showId/reservationId, parse it
// through this schema, and get back an object with every one of those keys
// silently removed — no compile error, no runtime error, no failing test,
// and record_stock_entry called with p_invoice_number: undefined regardless
// of what the operator typed. Widening the schema itself, rather than
// trusting a TypeScript-only seam layered on top of it, is what makes that
// failure loud (the field is simply absent from MovementFormInput) instead
// of invisible.

// The invoice number an entry came in on (0193, design D3). text on the
// table with no length limit of its own; 80 characters is prizeFormSchema's
// own internalCode bound, repurposed here for the identical reason — a
// value the database would happily store but no screen could display or
// compare sensibly.
const optionalInvoiceNumber = z
  .string()
  .trim()
  .max(80, 'Keep the invoice number to 80 characters or fewer.')
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

// unit_amount/total_amount (0193): numeric(12,2), and
// inventory_movements_amounts_nonnegative refuses a negative figure at the
// database — validated here for the same reason `quantity` above is, to turn
// that 22023 into a field-level message instead of a round trip.
//
// The upper bound is the same reasoning, on the other side (fix-round
// finding: this field was the one bound in this file with no ceiling at all,
// unlike optionalInvoiceNumber's 80 characters and prizeFormSchema's own
// internalCode/description limits above). numeric(12,2) has 12 significant
// digits and 2 of them after the point, so 9,999,999,999.99 is the largest
// value the column can hold — a figure past that fails PostgreSQL's own
// numeric-overflow check (22003, not 23514), which this codebase's action
// layer surfaces as a generic "could not save" rather than a field-level
// message, exactly the gap every other bound here exists to close.
const optionalAmount = z
  .number()
  .nonnegative('Amount cannot be negative.')
  .max(9_999_999_999.99, 'Amount cannot exceed 9,999,999,999.99.')
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : v));

// showId (reserve_stock's p_show_id) / reservationId (release_reservation's
// p_reservation_id) — both design D7/D5, 0194. Omitted is each door's own
// pre-Block-23 behaviour: an anonymous hold, or a release with no
// reservation to attribute it to.
const optionalUuid = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : v));

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
/**
 * Updating a prize names the prize, never its Company: update_prize (0027)
 * resolves the Organization and the Company from the prize row itself, so a
 * companyId here would be a value the RPC ignores — and a parameter that looks
 * like it decides something while deciding nothing is how a caller ends up
 * believing it can move a prize between Stations.
 */
export const prizeUpdateSchema = prizeFormSchema.omit({ companyId: true }).extend({
  prizeId: z.string().uuid(),
});

export type PrizeUpdateInput = z.infer<typeof prizeUpdateSchema>;

/**
 * reverse_movement's own two parameters (0194/0195, Task 6): a movement id
 * and a mandatory reason. The owner's ruling (Task 6 brief, note 1) is that
 * the Arquivar confirmation collects this reason rather than inventing a
 * fixed sentence on the operator's behalf — reverse_movement refuses a
 * blank note with 22023 exactly as record_stock_exit/reserve_stock/
 * release_reservation already do, so `note` reuses `mandatoryNote` for the
 * identical field-level message instead of a round trip.
 */
export const reverseMovementSchema = z.object({
  movementId: z.string().uuid('Missing movement.'),
  note: mandatoryNote,
});

export type ReverseMovementInput = z.infer<typeof reverseMovementSchema>;

export const movementFormSchema = z.discriminatedUnion('kind', [
  z.object({
    ...movementBase,
    kind: z.literal('entry'),
    // BARTER_ENTRY (0192, design D4) widened in alongside record_stock_entry's
    // own three (0194).
    entryType: z.enum(['INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY']),
    quantity,
    note: optionalNote,
    invoiceNumber: optionalInvoiceNumber,
    unitAmount: optionalAmount,
    totalAmount: optionalAmount,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('exit'),
    quantity,
    note: mandatoryNote,
    // record_stock_exit's own p_type (0194): MANUAL_EXIT or TRANSFER_EXIT.
    // Omitted keeps the door's own default of MANUAL_EXIT.
    type: z.enum(['MANUAL_EXIT', 'TRANSFER_EXIT']).optional(),
  }),
  z.object({
    ...movementBase,
    kind: z.literal('reserve'),
    quantity,
    note: mandatoryNote,
    showId: optionalUuid,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('release'),
    quantity,
    note: mandatoryNote,
    reservationId: optionalUuid,
  }),
  z.object({
    ...movementBase,
    kind: z.literal('adjustment'),
    counted: countedFigure,
    note: mandatoryNote,
  }),
]);

export type MovementFormInput = z.infer<typeof movementFormSchema>;
