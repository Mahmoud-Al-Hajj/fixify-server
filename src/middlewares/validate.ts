import type { Request, Response, NextFunction } from "express";
import type { ZodType, ZodError } from "zod";
import { ValidationError } from "../constants/errors";

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ValidationError(formatIssues(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}
