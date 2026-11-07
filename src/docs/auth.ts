import { z } from "zod";
import { ERROR_CODE } from "../constants/errors";
import type { login, register } from "../libraries/auth";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "../routes/auth.schema";
import { errors, messageBody, publicUser, whoCanCall } from "./components";
import {
  documented,
  jsonBody,
  jsonResponse,
  sameShape,
  type Paths,
} from "./convert";
import { DEMO_PASSWORD, RANA, TONY } from "./demo";

const TAGS = ["auth"];

const RATE_LIMIT = `Rate limited per client IP across the /auth routes: over the limit, 429 ${ERROR_CODE.RATE_LIMITED}.`;

// controllers/auth.ts registerHandler and loginHandler.
const session = z.object({
  user: publicUser,
  token: documented(z.string(), {
    description:
      "The session token: paste it into Authorize; every request with a lock sends it as Authorization: Bearer <token>.",
  }),
});
sameShape<z.output<typeof session>, Awaited<ReturnType<typeof register>>>(true);
sameShape<z.output<typeof session>, Awaited<ReturnType<typeof login>>>(true);

const GENERIC_PASSWORD = "your-password";

export const authPaths: Paths = {
  "/auth/register": {
    post: {
      tags: TAGS,
      operationId: "register",
      summary: "Create an account",
      description: whoCanCall(
        "anyone",
        `With becomeProvider the account is also a provider offering the given trades; an unknown or inactive category id is a 400. An email that is already registered is a 409, so change the example's email after the first run. ${RATE_LIMIT}`
      ),
      requestBody: jsonBody(registerSchema, {
        examples: {
          customer: {
            summary: "A customer",
            value: {
              fullName: "Nour Saad",
              email: "nour@example.com",
              phone: "+961 3 555 010",
              password: "Secret1234!",
            },
          },
          provider: {
            summary: "A provider (electrician and plumber)",
            value: {
              fullName: "Joe Maalouf",
              email: "joe@example.com",
              phone: "+961 3 555 020",
              password: "Secret1234!",
              becomeProvider: {
                bio: "Wiring and leaks, 10 years in Beirut.",
                yearsExperience: 10,
                categoryIds: [1, 2],
              },
            },
          },
        },
        fields: {
          fullName: "Shown to the other party on requests.",
          phone:
            "Digits, spaces, +, - and brackets. A provider's phone is shown to their customers; a customer's never is.",
          becomeProvider:
            "Also create a provider profile. Leave out for a customer.",
          "becomeProvider.categoryIds":
            "The trades offered: ids from GET /categories.",
        },
      }),
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
      description: whoCanCall(
        "anyone",
        `Copy token from the response into Authorize. A wrong email or a wrong password gets the same 401. ${RATE_LIMIT}`
      ),
      requestBody: jsonBody(loginSchema, {
        examples: {
          customer: {
            summary: `Customer: ${RANA.name} (demo)`,
            value: { email: RANA.email, password: DEMO_PASSWORD },
          },
          provider: {
            summary: `Provider: ${TONY.name} (demo)`,
            value: { email: TONY.email, password: DEMO_PASSWORD },
          },
        },
        productionExamples: {
          login: {
            summary: "Log in",
            value: {
              email: "customer@example.com",
              password: GENERIC_PASSWORD,
            },
          },
        },
      }),
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
      description: whoCanCall(
        "anyone",
        `The same 200 whether or not the email is registered. The token is stored but not sent anywhere yet: there is no email delivery. ${RATE_LIMIT}`
      ),
      requestBody: jsonBody(forgotPasswordSchema, {
        examples: {
          demo: { summary: "A demo account", value: { email: RANA.email } },
        },
        productionExamples: {
          email: {
            summary: "An email",
            value: { email: "customer@example.com" },
          },
        },
      }),
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
      description: whoCanCall(
        "anyone with a reset token",
        `An invalid, used or expired token is a 401. Tokens are not delivered yet, so the example returns 401. ${RATE_LIMIT}`
      ),
      requestBody: jsonBody(resetPasswordSchema, {
        examples: {
          reset: {
            summary: "Token and new password",
            value: {
              token: "the-token-from-forgot-password",
              newPassword: "NewSecret1234!",
            },
          },
        },
        fields: {
          token: "The token issued by forgot-password.",
          newPassword: "8 to 72 characters.",
        },
      }),
      responses: {
        200: jsonResponse("The password was reset", messageBody),
        ...errors(400, 401, 413, 429),
      },
    },
  },
};
