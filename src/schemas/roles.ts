import { z } from 'zod';

export const roleFormSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name the role.').max(60),
  description: z.string().trim().max(240).nullable().transform(v => v === null ? undefined : v),
  // The database primary key would reject a duplicate anyway; catching it here
  // means the form says so instead of the request failing.
  permissionCodes: z
    .array(z.string().min(1))
    .refine((codes) => new Set(codes).size === codes.length, 'A permission was listed twice.'),
});

export type RoleFormInput = z.infer<typeof roleFormSchema>;
