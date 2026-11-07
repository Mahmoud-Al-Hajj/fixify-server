import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { requireUser } from "./authenticate";
import { ERROR_CODE, TooManyRequestsError } from "../constants/errors";

// Every limiter answers through the error handler, so a 429 has the same
// { error: { code, message } } body as any other error.
function rejectWith(code: string, message: string) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(new TooManyRequestsError(message, code));
  };
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rejectWith(
    ERROR_CODE.RATE_LIMITED,
    "Too many attempts; try again later"
  ),
});

// Mounted after authenticate. Only analyses that actually started count
// (docs/ai-plan.md §12.3): a refused start is a failed request and is skipped.
export const analysisRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => requireUser(req).id,
  skipFailedRequests: true,
  handler: rejectWith(
    ERROR_CODE.ANALYSIS_RATE_LIMITED,
    "Too many diagnoses this hour; try again later"
  ),
});
