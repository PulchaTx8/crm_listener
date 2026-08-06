import { describe, expect, it } from 'vitest';
import { actionLabel, actorLabel } from '@/lib/audit/labels';
import { auditFilterSchema } from '@/schemas/audit';

describe('action labels', () => {
  it('names the codes it knows', () => {
    expect(actionLabel('create_member')).toBe('Listener registered');
    expect(actionLabel('request_report')).toBe('Report exported');
    expect(actionLabel('configure_integration')).toBe('WhatsApp integration configured');
  });

  /**
   * The fallback is the whole reason this is a lookup rather than a renderer
   * per action. A later block adds a code, nobody updates this map, and the
   * viewer shows the raw code -- ugly, honest, and self-announcing. The
   * alternative renders nothing, which in an audit viewer is indistinguishable
   * from an event that carried no detail.
   */
  it('falls back to the raw code, never to an empty string', () => {
    expect(actionLabel('some_future_action')).toBe('some_future_action');
    expect(actionLabel('')).toBe('');
  });
});

describe('the actor label', () => {
  it('says "(system)" only when there is no actor at all', () => {
    expect(actorLabel({ actor_id: null, actor_name: null })).toBe('(system)');
  });

  /**
   * The assertion this file exists for, and the rule 0096 paid for once.
   * actor_name is profiles.full_name and is NULLABLE, so a null name does not
   * mean the system acted -- it equally means a real operator who never set a
   * display name. A screen keying "(system)" off the name would label real
   * people the system, in the one place where being wrong about who did
   * something matters most.
   */
  it('does NOT say "(system)" for a real person with no display name', () => {
    const label = actorLabel({
      actor_id: '11111111-1111-4111-8111-111111111111',
      actor_name: null,
    });
    expect(label).not.toBe('(system)');
    expect(label).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('uses the name when there is one', () => {
    expect(
      actorLabel({ actor_id: '11111111-1111-4111-8111-111111111111', actor_name: 'Ana' }),
    ).toBe('Ana');
  });
});

describe('the audit filters', () => {
  it('refuses a window that does not open before it closes', () => {
    expect(auditFilterSchema.safeParse({ from: '2026-08-01', to: '2026-08-01' }).success).toBe(
      false,
    );
    expect(auditFilterSchema.safeParse({ from: '2026-08-01', to: '2026-08-02' }).success).toBe(
      true,
    );
  });

  it('refuses a date that is well-formed but not real', () => {
    expect(auditFilterSchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
  });

  it('accepts an empty filter set, which is the default view', () => {
    expect(auditFilterSchema.safeParse({}).success).toBe(true);
  });
});
