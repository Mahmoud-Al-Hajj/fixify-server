import type { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import {
  DomainError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  InvalidTransitionError,
} from "../constants/errors";

const STATUS_BY_ERROR = new Map<Function, number>([
  [ValidationError, 400],
  [UnauthorizedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
  [InvalidTransitionError, 409],
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

  // express.json() rejects a malformed or oversized body with a 4xx status.
  if (
    err instanceof Error &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  ) {
    const tooLarge = err.status === 413;
    res.status(err.status).json({
      error: {
        code: tooLarge ? "PAYLOAD_TOO_LARGE" : "VALIDATION_FAILED",
        message: tooLarge ? "Request body too large" : "Malformed request body",
      },
    });
    return;
  }

  // Unexpected — always log server-side, never leak details to the client
  logger.error("unhandled error", {
    requestId: req.id,
    userId: req.user?.id,
    method: req.method,
    path: req.originalUrl,
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}
