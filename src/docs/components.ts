import { STATUS_CODES } from "node:http";
import { z } from "zod";
import {
  ConflictError,
  DomainError,
  ERROR_CODE,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from "../constants/errors";
import { STATUS_BY_ERROR } from "../middlewares/error-handler";
import type { PublicUser } from "../models-db/users";
import {
  docsRegistry,
  jsonResponse,
  registeredSchemas,
  sameShape,
  type Operation,
  type Response,
} from "./convert";

function statusOf(errorClass: Function): number {
  const status = STATUS_BY_ERROR.get(errorClass);
  if (status === undefined) {
    throw new Error(`${errorClass.name} has no status in STATUS_BY_ERROR`);
  }
  return status;
}

// Each error class's default code, at the status error-handler.ts gives the
// class.
function defaultCodes(): Array<[string, number]> {
  return [...STATUS_BY_ERROR].map(([errorClass, status]) => {
    const error: unknown = Reflect.construct(errorClass, [""]);
    if (!(error instanceof DomainError)) {
      throw new Error(`${errorClass.name} is not a DomainError`);
    }
    return [error.code, status];
  });
}

// The class each specific code is thrown with (see its throw sites), and the
// two codes error-handler.ts sets itself. Keyed by every ERROR_CODE value, so
// a new code without a status here fails tsc.
const SPECIFIC_CODE_STATUS: Record<
  (typeof ERROR_CODE)[keyof typeof ERROR_CODE],
  number
> = {
  [ERROR_CODE.SESSION_ALREADY_BOOKED]: statusOf(ConflictError),
  [ERROR_CODE.ANALYSIS_PENDING]: statusOf(ConflictError),
  [ERROR_CODE.SESSION_PHOTO_CAP_REACHED]: statusOf(ValidationError),
  [ERROR_CODE.SESSION_HAS_NO_TEXT]: statusOf(ValidationError),
  [ERROR_CODE.ANALYSIS_CAP_REACHED]: statusOf(TooManyRequestsError),
  [ERROR_CODE.ANALYSIS_RATE_LIMITED]: statusOf(TooManyRequestsError),
  [ERROR_CODE.AI_NOT_CONFIGURED]: statusOf(ServiceUnavailableError),
  [ERROR_CODE.RATE_LIMITED]: statusOf(TooManyRequestsError),
  [ERROR_CODE.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODE.INTERNAL_ERROR]: 500,
};

function codesByStatus(): Map<number, string[]> {
  const byStatus = new Map<number, string[]>();
  for (const [code, status] of [
    ...defaultCodes(),
    ...Object.entries(SPECIFIC_CODE_STATUS),
  ]) {
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return byStatus;
}

const errorResponseName = (status: number) => `Error${status}`;

// One response per error status, its code limited to the codes that status
// carries anywhere in the API. Every error body is { error: { code, message } }
// (error-handler.ts).
const ERROR_RESPONSES: Record<string, Response> = Object.fromEntries(
  [...codesByStatus()]
    .sort(([a], [b]) => a - b)
    .map(([status, codes]) => [
      errorResponseName(status),
      jsonResponse(
        STATUS_CODES[status] ?? `HTTP ${status}`,
        z.object({
          error: z.object({ code: z.enum(codes), message: z.string() }),
        })
      ),
    ])
);

// An operation's error responses: the given statuses, plus 500, which any
// route can return.
export function errors(...statuses: number[]): Operation["responses"] {
  return Object.fromEntries(
    [...statuses, 500].map((status) => [
      String(status),
      { $ref: `#/components/responses/${errorResponseName(status)}` },
    ])
  );
}

// authenticate (middlewares/authenticate.ts): Authorization: Bearer <JWT>.
export const BEARER_AUTH = [{ bearerAuth: [] }];

// Every DATETIME column is DATETIME(3) (schema.sql) and formatMysqlDateTime
// (models-db/format-datetime.ts) only swaps the space for a T, so every time
// the API returns has exactly this shape.
export const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
  .register(docsRegistry, {
    id: "WallClock",
    description:
      "Beirut wall-clock time with no offset. Treat it as Asia/Beirut explicitly; never parse it with new Date(string).",
    examples: ["2026-09-29T08:00:00.000"],
  });

// models-db/users.ts PublicUser; controllers/auth.ts and controllers/users.ts.
export const publicUser = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    email: z.string(),
    phone: z.string(),
    avatarUrl: z.string().nullable(),
    isProvider: z.boolean(),
  })
  .register(docsRegistry, { id: "PublicUser" });
sameShape<z.output<typeof publicUser>, PublicUser>(true);

// controllers/auth.ts (forgot and reset password), controllers/users.ts
// (change password).
export const messageBody = z.object({ message: z.string() });

// Called after every resource file has registered its schemas.
export function components() {
  return {
    schemas: registeredSchemas(),
    responses: ERROR_RESPONSES,
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  };
}
