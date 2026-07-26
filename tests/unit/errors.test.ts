import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InternalError,
} from '@/lib/errors';

describe('errors', () => {
  it('mapeia httpStatus por categoria', () => {
    expect(new ValidationError('x').httpStatus).toBe(422);
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new InternalError('x').httpStatus).toBe(500);
  });

  it('toSafeJSON não vaza cause nem stack', () => {
    const err = new InternalError('boom', { cause: new Error('db senha=123') });
    const safe = err.toSafeJSON();
    expect(safe).toEqual({ code: 'INTERNAL', category: 'internal', message: 'boom' });
    expect(JSON.stringify(safe)).not.toContain('senha');
  });

  it('são instâncias de AppError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(AppError);
  });
});
