import { z } from "zod";
import { ERROR_CODE } from "../constants/errors";
import {
  changePasswordSchema,
  updateCurrentUserSchema,
} from "../routes/users.schema";
import { BEARER_AUTH, errors, messageBody, publicUser } from "./components";
import { jsonBody, jsonResponse, type Paths } from "./convert";

const TAGS = ["users"];

// controllers/users.ts getCurrentUserHandler and updateCurrentUserHandler.
const userBody = z.object({ user: publicUser });

export const usersPaths: Paths = {
  "/users/me": {
    get: {
      tags: TAGS,
      operationId: "getCurrentUser",
      summary: "The signed-in user",
      description: "A deleted account is a 401.",
      security: BEARER_AUTH,
      responses: {
        200: jsonResponse("The user", userBody),
        ...errors(401),
      },
    },
    patch: {
      tags: TAGS,
      operationId: "updateCurrentUser",
      summary: "Change the signed-in user's name or phone",
      description:
        'Omitted fields stay as they are. A body with no field is a 400: "Provide at least one field to update". Unknown fields are a 400.',
      security: BEARER_AUTH,
      requestBody: jsonBody(updateCurrentUserSchema),
      responses: {
        200: jsonResponse("The updated user", userBody),
        ...errors(400, 401, 413),
      },
    },
  },
  "/users/me/password": {
    post: {
      tags: TAGS,
      operationId: "changePassword",
      summary: "Change the signed-in user's password",
      description: `A wrong currentPassword is a 403, not a 401, so the app does not treat it as an expired session. Shares the /auth rate limit, per client IP: over it, 429 ${ERROR_CODE.RATE_LIMITED}.`,
      security: BEARER_AUTH,
      requestBody: jsonBody(changePasswordSchema),
      responses: {
        200: jsonResponse("The password was changed", messageBody),
        ...errors(400, 401, 403, 413, 429),
      },
    },
  },
};
