import { z } from "zod";
import { ERROR_CODE } from "../constants/errors";
import type { login, register } from "../libraries/auth";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "../routes/auth.schema";
import { errors, messageBody, publicUser } from "./components";
import { jsonBody, jsonResponse, sameShape, type Paths } from "./convert";

const TAGS = ["auth"];

const RATE_LIMIT = `Rate limited per client IP across the /auth routes: over the limit, 429 ${ERROR_CODE.RATE_LIMITED}.`;

// controllers/auth.ts registerHandler and loginHandler.
const session = z.object({ user: publicUser, token: z.string() });
sameShape<z.output<typeof session>, Awaited<ReturnType<typeof register>>>(true);
sameShape<z.output<typeof session>, Awaited<ReturnType<typeof login>>>(true);

export const authPaths: Paths = {
  "/auth/register": {
    post: {
      tags: TAGS,
      operationId: "register",
      summary: "Create an account",
      description: `With becomeProvider the account is also a provider offering the given trades; an unknown or inactive category id is a 400. An email that is already registered is a 409. ${RATE_LIMIT}`,
      requestBody: jsonBody(registerSchema),
      responses: {
        201: jsonResponse("The new user and a session token", session),
        ...errors(400, 409, 413, 429),
      },
    },
  },
  "/auth/login": {
    post: {
      tags: TAGS,
      operationId: "login",
      summary: "Log in",
      description: `A wrong email or a wrong password gets the same 401. ${RATE_LIMIT}`,
      requestBody: jsonBody(loginSchema),
      responses: {
        200: jsonResponse("The user and a session token", session),
        ...errors(400, 401, 413, 429),
      },
    },
  },
  "/auth/forgot-password": {
    post: {
      tags: TAGS,
      operationId: "forgotPassword",
      summary: "Issue a password reset token",
      description: `The same 200 whether or not the email is registered. ${RATE_LIMIT}`,
      requestBody: jsonBody(forgotPasswordSchema),
      responses: {
        200: jsonResponse("Always the same message", messageBody),
        ...errors(400, 413, 429),
      },
    },
  },
  "/auth/reset-password": {
    post: {
      tags: TAGS,
      operationId: "resetPassword",
      summary: "Set a new password with a reset token",
      description: `An invalid, used or expired token is a 401. ${RATE_LIMIT}`,
      requestBody: jsonBody(resetPasswordSchema),
      responses: {
        200: jsonResponse("The password was reset", messageBody),
        ...errors(400, 401, 413, 429),
      },
    },
  },
};
