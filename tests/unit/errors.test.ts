import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InternalError,
} from '@/lib/errors';

describe('errors', () => {
  it('maps httpStatus by category', () => {
    expect(new ValidationError('x').httpStatus).toBe(422);
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new InternalError('x').httpStatus).toBe(500);
  });

  it('toSafeJSON leaks neither cause nor stack', () => {
    const err = new InternalError('boom', { cause: new Error('db password=123') });
    const safe = err.toSafeJSON();
    expect(safe).toEqual({ code: 'INTERNAL', category: 'internal', message: 'boom' });
    expect(JSON.stringify(safe)).not.toContain('password');
  });

  it('are instances of AppError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(AppError);
  });
});
