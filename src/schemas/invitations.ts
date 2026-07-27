import { z } from 'zod';

export const createInvitationSchema = z
  .object({
    organizationId: z.string().uuid(),
    email: z.string().trim().toLowerCase().email(),
    isOwner: z.boolean(),
    roleId: z.string().uuid().nullable(),
    companyIds: z.array(z.string().uuid()),
  })
  // The database enforces this too. Stating it here turns a 22023 from Postgres
  // into a field-level message the form can render.
  .refine((v) => (v.isOwner ? v.roleId === null : v.roleId !== null), {
    message: 'Choose a role for this person.',
    path: ['roleId'],
  })
  .refine((v) => (v.isOwner ? true : v.companyIds.length > 0), {
    message: 'Choose at least one Station.',
    path: ['companyIds'],
  });

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(20),
    fullName: z.string().trim().min(2).max(120).optional(),
    // Mirrors minimum_password_length in supabase/config.toml.
    password: z.string().min(10).max(200),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match.',
    path: ['confirm'],
  });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
