import { z } from 'zod';

export const createInvitationSchema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'operator', 'viewer']),
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
