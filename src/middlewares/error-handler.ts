import type { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import {
  DomainError,
  ERROR_CODE,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  InvalidTransitionError,
  TooManyRequestsError,
  ServiceUnavailableError,
} from "../constants/errors";

export const STATUS_BY_ERROR = new Map<Function, number>([
  [ValidationError, 400],
  [UnauthorizedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
  [InvalidTransitionError, 409],
  [TooManyRequestsError, 429],
  [ServiceUnavailableError, 503],
]);

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof DomainError) {
    const status = STATUS_BY_ERROR.get(err.constructor) ?? 500;
    res
      .status(status)
      .json({ error: { code: err.code, message: err.message } });
    return;
  }

  // express.json() rejects a malformed or oversized body with a 4xx status
  // and a string `type` (e.g. "entity.parse.failed"); other libraries' 4xx
  // errors carry no `type` and fall through to the 500 path.
  if (
    err instanceof Error &&
    "type" in err &&
    typeof err.type === "string" &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  ) {
    // A malformed body answers like any other ValidationError (same code).
    const error =
      err.status === 413
        ? {
            code: ERROR_CODE.PAYLOAD_TOO_LARGE,
            message: "Request body too large",
          }
        : new ValidationError("Malformed request body");
    res
      .status(err.status)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }

  // Unexpected: logged with its stack so the failing line can be found; the
  // client only ever sees the generic message.
  logger.error("unhandled error", {
    requestId: req.id,
    userId: req.user?.id,
    method: req.method,
    path: req.originalUrl,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({
    error: { code: ERROR_CODE.INTERNAL_ERROR, message: "Something went wrong" },
  });
}
