import type { Request, Response, NextFunction } from "express";
import { NotFoundError } from "../constants/errors";

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  next(new NotFoundError("Route not found"));
}
