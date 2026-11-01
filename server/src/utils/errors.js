export class AppError extends Error {
  constructor(message, status = 500, errors = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.errors = errors;
  }
}

export class ValidationError extends AppError {
  constructor(errors) {
    super('Validation failed', 422);
    this.name = 'ValidationError';
    this.type = 'validation';
    this.errors = errors;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied.') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found.`, 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}
