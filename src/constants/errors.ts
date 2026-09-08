export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class UnauthorizedError extends DomainError {
  readonly code = "UNAUTHORIZED";
}
export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
}
export class ForbiddenError extends DomainError {
  readonly code = "FORBIDDEN";
}
export class ConflictError extends DomainError {
  readonly code = "CONFLICT";
}
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_FAILED";
}
export class InvalidTransitionError extends DomainError {
  readonly code = "INVALID_TRANSITION";
}
