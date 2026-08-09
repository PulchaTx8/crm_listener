import { z } from 'zod';

/**
 * PROVISIONING NO LONGER TAKES A STATION NAME. Block 16, D1: how many radios a
 * customer has is not known when the customer is taken on, and the old form's
 * single "company name" field is exactly what made every group in this platform
 * look like a single station. Stations are added afterwards, one at a time, on
 * the screen that lists them.
 */
export const provisionOrganizationSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(2).max(120).optional(),
});

export type ProvisionOrganizationInput = z.infer<typeof provisionOrganizationSchema>;

/**
 * A CNPJ arrives however the operator typed it and is normalised on the way in
 * (src/lib/tax-id.ts), so the schema accepts punctuation and the service strips
 * it. Validating the shape here as well would refuse `12.345.678/0001-99` at the
 * form, which is the form the number is printed in.
 */
export const updateOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).optional(),
  taxId: z.string().trim().max(30).optional(),
  municipalRegistration: z.string().trim().max(40).optional(),
  fiscalEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
  billingEntity: z.enum(['ORGANIZATION', 'STATIONS']).default('STATIONS'),
  addressLine: z.string().trim().max(200).optional(),
  addressNumber: z.string().trim().max(20).optional(),
  addressComplement: z.string().trim().max(80).optional(),
  neighbourhood: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(20).optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * A REASON IS REQUIRED. `organizations_block_shape` (0154) already refuses a
 * block with no author, and this is the same argument one field over: a block
 * nobody wrote a reason for is a block nobody can be asked about when the
 * customer telephones.
 */
export const blockOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

export type BlockOrganizationInput = z.infer<typeof blockOrganizationSchema>;
