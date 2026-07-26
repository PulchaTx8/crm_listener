export type ErrorCategory =
  | 'validation'
  | 'unauthenticated'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'business_rule'
  | 'rate_limit'
  | 'integration'
  | 'internal';

interface AppErrorOptions {
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  abstract readonly httpStatus: number;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }

  toSafeJSON(): { code: string; category: ErrorCategory; message: string } {
    return { code: this.code, category: this.category, message: this.message };
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION';
  readonly category = 'validation' as const;
  readonly httpStatus = 422;
}
export class UnauthenticatedError extends AppError {
  readonly code = 'UNAUTHENTICATED';
  readonly category = 'unauthenticated' as const;
  readonly httpStatus = 401;
}
export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly category = 'unauthorized' as const;
  readonly httpStatus = 403;
}
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly category = 'not_found' as const;
  readonly httpStatus = 404;
}
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  readonly category = 'conflict' as const;
  readonly httpStatus = 409;
}
export class BusinessRuleError extends AppError {
  readonly code = 'BUSINESS_RULE';
  readonly category = 'business_rule' as const;
  readonly httpStatus = 422;
}
export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMIT';
  readonly category = 'rate_limit' as const;
  readonly httpStatus = 429;
}
export class IntegrationError extends AppError {
  readonly code = 'INTEGRATION';
  readonly category = 'integration' as const;
  readonly httpStatus = 502;
}
export class InternalError extends AppError {
  readonly code = 'INTERNAL';
  readonly category = 'internal' as const;
  readonly httpStatus = 500;
}
