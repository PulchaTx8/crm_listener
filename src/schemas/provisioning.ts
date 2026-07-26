import { z } from 'zod';

export const provisionCustomerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(1).default('America/Sao_Paulo'),
});

export type ProvisionCustomerInput = z.infer<typeof provisionCustomerSchema>;
