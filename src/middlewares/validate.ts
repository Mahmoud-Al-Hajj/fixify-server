import type { Request, Response, NextFunction, RequestHandler } from "express";
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

export type QueryLocals<T> = { query: T };
export type ParamsLocals<T> = { params: T };

// Express 5 exposes req.query as a getter with no setter, re-parsed on every
// read, and types req.params per key as string | string[]. So the parsed
// result goes on res.locals, where the handler reads it with the schema's
// type and no cast.
export function validate<K extends "query" | "params", T>(
  part: K,
  schema: ZodType<T>
): RequestHandler<
  Request["params"],
  unknown,
  unknown,
  Request["query"],
  Record<K, T>
> {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      next(new ValidationError(formatIssues(result.error)));
      return;
    }
    const locals: Record<K, T> = res.locals;
    locals[part] = result.data;
    next();
  };
}
