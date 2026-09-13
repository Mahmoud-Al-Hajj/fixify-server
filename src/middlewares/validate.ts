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

// Express 5 exposes req.query as a getter with no setter, re-parsed on every
// read, so the parsed result lives on res.locals instead.
export function validateQuery<T>(
  schema: ZodType<T>
): RequestHandler<
  Request["params"],
  unknown,
  unknown,
  Request["query"],
  QueryLocals<T>
> {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new ValidationError(formatIssues(result.error)));
      return;
    }
    res.locals.query = result.data;
    next();
  };
}

export type ParamsLocals<T> = { params: T };

// req.params is typed string | string[] per key, so the parsed result goes on
// res.locals, where the handler reads it with the schema's type and no cast.
export function validateParams<T>(
  schema: ZodType<T>
): RequestHandler<
  Request["params"],
  unknown,
  unknown,
  Request["query"],
  ParamsLocals<T>
> {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(new ValidationError(formatIssues(result.error)));
      return;
    }
    res.locals.params = result.data;
    next();
  };
}
