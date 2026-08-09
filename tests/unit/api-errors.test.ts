import { describe, expect, it } from 'vitest';
import { mapPostgresError } from '@/lib/api/errors';

describe('mapPostgresError', () => {
  it('turns a permission refusal into 403 with a stable code', () => {
    const mapped = mapPostgresError('42501', 'permission denied: music.manage required');
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('forbidden_scope');
    // The raw text names the missing scope, which is exactly what an integrator
    // needs and gives away nothing: they already hold a valid key.
    expect(mapped.message).toContain('music.manage');
  });

  it('turns a missing programme into 422 rather than 404, because the caller sent it', () => {
    const mapped = mapPostgresError('P0002', 'programme not found in this station: Tarde');
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe('show_not_found');
  });

  it('recognises the anonymised listener as a conflict', () => {
    const mapped = mapPostgresError('23514', 'that listener has been anonymised');
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('listener_anonymized');
  });

  it('recognises the nameless listener', () => {
    const mapped = mapPostgresError('22023', 'a new listener must arrive with a name');
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe('listener_name_required');
  });

  it('keeps other 22023 refusals as a payload problem', () => {
    const mapped = mapPostgresError('22023', 'a song must name an artist');
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe('invalid_payload');
  });

  it('NEVER passes raw database text through on an unknown code', () => {
    // describeMusicReadError already writes the rule down for the screens: an
    // internal error means the fault is ours, and its message may carry a raw
    // database error. This body goes to somebody else's log file.
    const mapped = mapPostgresError('XX000', 'stack smashing detected in pg_catalog.foo');
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('internal');
    expect(mapped.message).not.toContain('pg_catalog');
  });
});
