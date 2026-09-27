import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { UnauthorizedError } from "../constants/errors";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): { sub: string } {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, env.jwt.secret);
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }

  if (typeof decoded === "string" || typeof decoded.sub !== "string") {
    throw new UnauthorizedError("Invalid token payload");
  }

  return { sub: decoded.sub };
}
