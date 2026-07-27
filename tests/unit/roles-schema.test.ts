import { describe, expect, it } from 'vitest';
import { roleFormSchema } from '@/schemas/roles';

describe('roleFormSchema', () => {
  it('accepts a named role with permissions', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: 'Runs the station day to day',
      permissionCodes: ['users.invite'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a role with no permissions, because an empty role is a real state', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Trainee',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a blank name, which would render as an unclickable row', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: '   ',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a duplicated permission code', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: null,
      permissionCodes: ['users.invite', 'users.invite'],
    });
    expect(parsed.success).toBe(false);
  });
});
