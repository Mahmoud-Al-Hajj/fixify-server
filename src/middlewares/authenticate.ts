import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../libraries/jwt";
import { UnauthorizedError } from "../constants/errors";

export function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next(new UnauthorizedError("Missing or invalid authorization header"));
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub };
  next();
}
