// Each class sets the HTTP status (error-handler.ts) and a default code; a
// service may pass a more specific code for a refusal the client acts on,
// e.g. new ConflictError(message, "SESSION_ALREADY_BOOKED").
export abstract class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string, code = "UNAUTHORIZED") {
    super(message, code);
  }
}
export class NotFoundError extends DomainError {
  constructor(message: string, code = "NOT_FOUND") {
    super(message, code);
  }
}
export class ForbiddenError extends DomainError {
  constructor(message: string, code = "FORBIDDEN") {
    super(message, code);
  }
}
export class ConflictError extends DomainError {
  constructor(message: string, code = "CONFLICT") {
    super(message, code);
  }
}
export class ValidationError extends DomainError {
  constructor(message: string, code = "VALIDATION_FAILED") {
    super(message, code);
  }
}
export class InvalidTransitionError extends DomainError {
  constructor(message: string, code = "INVALID_TRANSITION") {
    super(message, code);
  }
}

// Specific codes for refusals the client acts on.
export const ERROR_CODE = {
  SESSION_ALREADY_BOOKED: "SESSION_ALREADY_BOOKED",
  ANALYSIS_PENDING: "ANALYSIS_PENDING",
  SESSION_PHOTO_CAP_REACHED: "SESSION_PHOTO_CAP_REACHED",
} as const;
