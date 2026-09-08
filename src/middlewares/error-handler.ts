import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import {
  DomainError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  InvalidTransitionError,
} from "../constants/errors";

const STATUS_BY_ERROR = new Map<Function, number>([
  [ValidationError, 400],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
  [InvalidTransitionError, 409],
]);

export function errorHandler(
  err: unknown,
  _req: Request,
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

  // Unexpected — log it server-side, never leak details
  if (env.nodeEnv !== "production") {
    process.stderr.write(`${String(err)}\n`);
  }
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}
