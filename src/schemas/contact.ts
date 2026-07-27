import { z } from 'zod';

export const contactRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional(),
  companyName: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000).optional(),
});

export type ContactRequestInput = z.infer<typeof contactRequestSchema>;
