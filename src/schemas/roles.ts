import { z } from 'zod';

export const roleFormSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name the role.').max(60),
  description: z
    .string()
    .trim()
    .max(240)
    .nullable()
    // The RPC treats an empty string, null and an absent argument identically
    // (via nullif(trim(coalesce(p_description,'')), '')). Normalising both null
    // and '' to undefined here means the system has one shape for "no description"
    // rather than three spellings of it reaching the database.
    .transform((v) => (v === null || v === '' ? undefined : v)),
  // The database primary key would reject a duplicate anyway; catching it here
  // means the form says so instead of the request failing.
  permissionCodes: z
    .array(z.string().min(1))
    .refine((codes) => new Set(codes).size === codes.length, 'A permission was listed twice.'),
});

export type RoleFormInput = z.infer<typeof roleFormSchema>;
