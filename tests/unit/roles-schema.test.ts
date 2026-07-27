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
    if (parsed.success) {
      expect(parsed.data.name).toBe('Manager');
      expect(parsed.data.description).toBe('Runs the station day to day');
      expect(parsed.data.permissionCodes).toEqual(['users.invite']);
    }
  });

  it('accepts a role with no permissions, because an empty role is a real state', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Trainee',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBeUndefined();
      expect(parsed.data.permissionCodes).toEqual([]);
    }
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

  it('rejects an invalid organizationId that is not a UUID', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: 'not-a-uuid',
      name: 'Manager',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a name exceeding 60 characters', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'A'.repeat(61),
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a name at the 60-character bound', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'A'.repeat(60),
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.length).toBe(60);
    }
  });

  it('rejects a description exceeding 240 characters', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: 'A'.repeat(241),
      permissionCodes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a description at the 240-character bound', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: 'A'.repeat(240),
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.description!.length).toBe(240);
  });

  it('trims whitespace from name', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: '  Manager  ',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Manager');
    }
  });

  it('trims whitespace from description', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: '  Runs the station  ',
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe('Runs the station');
    }
  });

  it('converts empty description to undefined', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: '   ',
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBeUndefined();
    }
  });

  it('rejects an empty permission code', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: null,
      permissionCodes: ['users.invite', ''],
    });
    expect(parsed.success).toBe(false);
  });
});
