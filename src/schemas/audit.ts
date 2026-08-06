import { z } from 'zod';

/**
 * Block 10a. One audit row, and the filters the viewer offers.
 *
 * NOT `.strict()`, unlike Block 8b's schemas, and the difference is not
 * carelessness. 8b's payloads come back from functions this codebase owns, where
 * an unexpected key means a contract drifted. This one parses a row whose
 * `detail` is `jsonb` written by forty different call sites across nine blocks —
 * being strict about the ROW is right, being strict about what is inside
 * `detail` is not possible and should not be attempted.
 */
export const auditRowSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  actor_id: z.string().uuid().nullable(),
  actor_name: z.string().nullable(),
  action: z.string(),
  target_table: z.string().nullable(),
  target_id: z.string().uuid().nullable(),
  organization_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  company_name: z.string().nullable(),
  succeeded: z.boolean(),
  // Deliberately unconstrained. Nine blocks wrote into this and Block 11 will
  // write more; a schema here would reject a row rather than describe it.
  detail: z.unknown(),
  total_count: z.number(),
});

export type AuditRow = z.infer<typeof auditRowSchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const parts = value.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'not a real date');

export const auditFilterSchema = z
  .object({
    actorId: z.string().uuid().optional(),
    action: z.string().min(1).max(60).optional(),
    targetTable: z.string().min(1).max(60).optional(),
    companyId: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    succeeded: z.boolean().optional(),
  })
  .refine(
    (value) => value.from === undefined || value.to === undefined || value.from < value.to,
    { message: 'the period must open before it closes' },
  );

export type AuditFilters = z.infer<typeof auditFilterSchema>;
