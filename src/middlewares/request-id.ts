import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}
