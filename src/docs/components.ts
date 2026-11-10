import { STATUS_CODES } from "node:http";
import { z } from "zod";
import {
  ConflictError,
  DomainError,
  ERROR_CODE,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../constants/errors";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";
import type { EventEntry } from "../libraries/event-entries";
import { STATUS_BY_ERROR } from "../middlewares/error-handler";
import type { PublicUser } from "../models-db/users";
import {
  docsRegistry,
  documented,
  jsonResponse,
  registeredSchemas,
  sameShape,
  type Operation,
  type Response,
} from "./convert";

interface ErrorCodeDoc {
  code: string;
  status: number;
  meaning: string;
}

function statusOf(errorClass: Function): number {
  const status = STATUS_BY_ERROR.get(errorClass);
  if (status === undefined) {
    throw new Error(`${errorClass.name} has no status in STATUS_BY_ERROR`);
  }
  return status;
}

// What each error class's default code means to a client. Every class in
// STATUS_BY_ERROR needs one (defaultCodes throws otherwise).
const CLASS_MEANING = new Map<Function, string>([
  [
    ValidationError,
    "The body, query or path is invalid, or a value breaks a rule; the message names the field.",
  ],
  [
    UnauthorizedError,
    "No token, an invalid or expired token, a deleted account, or a wrong email or password.",
  ],
  [
    ForbiddenError,
    "Signed in, but this user may not do this (e.g. not the right party on the request).",
  ],
  [NotFoundError, "The resource, or the route itself, does not exist."],
  [
    ConflictError,
    "The current state does not allow it (e.g. the slot was taken, the email is registered); read the resource again and retry.",
  ],
  [
    InvalidTransitionError,
    "The request or visit cannot move to that status from the one it is in.",
  ],
  [TooManyRequestsError, "Too many requests; try again later."],
  [ServiceUnavailableError, "A service the server needs is unavailable."],
]);

// Each error class's default code, at the status error-handler.ts gives the
// class.
function defaultCodes(): ErrorCodeDoc[] {
  return [...STATUS_BY_ERROR].map(([errorClass, status]) => {
    const error: unknown = Reflect.construct(errorClass, [""]);
    const meaning = CLASS_MEANING.get(errorClass);
    if (!(error instanceof DomainError) || meaning === undefined) {
      throw new Error(`${errorClass.name} needs a DomainError and a meaning`);
    }
    return { code: error.code, status, meaning };
  });
}

// The class each specific code is thrown with (see its throw sites), and the
// two codes error-handler.ts sets itself. Keyed by every ERROR_CODE value, so
// a new code without a status and a meaning here fails tsc.
const SPECIFIC_CODES: Record<
  (typeof ERROR_CODE)[keyof typeof ERROR_CODE],
  { status: number; meaning: string }
> = {
  [ERROR_CODE.SESSION_ALREADY_BOOKED]: {
    status: statusOf(ConflictError),
    meaning:
      "The intake session already became a request; it takes no more messages or analyses.",
  },
  [ERROR_CODE.ANALYSIS_PENDING]: {
    status: statusOf(ConflictError),
    meaning: "An analysis of this session is running; wait for it to finish.",
  },
  [ERROR_CODE.SESSION_PHOTO_CAP_REACHED]: {
    status: statusOf(ValidationError),
    meaning: "The session already holds as many photos as it can.",
  },
  [ERROR_CODE.SESSION_HAS_NO_TEXT]: {
    status: statusOf(ValidationError),
    meaning: "The session needs at least one customer message with text.",
  },
  [ERROR_CODE.TIME_OVERLAP]: {
    status: statusOf(ConflictError),
    meaning:
      "Creating a request or changing its requested start: the time overlaps an open visit of the provider or your own pending request to them. Accepting a quote onto a taken slot stays CONFLICT.",
  },
  [ERROR_CODE.ANALYSIS_CAP_REACHED]: {
    status: statusOf(TooManyRequestsError),
    meaning: "The session has used all its analysis attempts.",
  },
  [ERROR_CODE.ANALYSIS_RATE_LIMITED]: {
    status: statusOf(TooManyRequestsError),
    meaning: "Too many analyses started this hour; try again later.",
  },
  [ERROR_CODE.AI_NOT_CONFIGURED]: {
    status: statusOf(ServiceUnavailableError),
    meaning:
      "The diagnosis is not available on this server; choose a category instead.",
  },
  [ERROR_CODE.RATE_LIMITED]: {
    status: statusOf(TooManyRequestsError),
    meaning:
      "Too many attempts on /auth or the change-password endpoint from this address; try again later.",
  },
  [ERROR_CODE.PAYLOAD_TOO_LARGE]: {
    status: 413,
    meaning: "The JSON body or a photo is too large.",
  },
  [ERROR_CODE.INTERNAL_ERROR]: {
    status: 500,
    meaning:
      "An unexpected server error; the details are only in the server log.",
  },
};

function codesByStatus(): Map<number, ErrorCodeDoc[]> {
  const byStatus = new Map<number, ErrorCodeDoc[]>();
  for (const doc of [
    ...defaultCodes(),
    ...Object.entries(SPECIFIC_CODES).map(([code, rest]) => ({
      code,
      ...rest,
    })),
  ]) {
    byStatus.set(doc.status, [...(byStatus.get(doc.status) ?? []), doc]);
  }
  return byStatus;
}

const errorResponseName = (status: number) => `Error${status}`;

// One response per error status, its code limited to the codes that status
// carries anywhere in the API, each listed with what it means. Every error
// body is { error: { code, message } } (error-handler.ts).
const ERROR_RESPONSES: Record<string, Response> = Object.fromEntries(
  [...codesByStatus()]
    .sort(([a], [b]) => a - b)
    .map(([status, docs]) => [
      errorResponseName(status),
      jsonResponse(
        [
          STATUS_CODES[status] ?? `HTTP ${status}`,
          ...docs.map(({ code, meaning }) => `- \`${code}\`: ${meaning}`),
        ].join("\n"),
        z.object({
          error: z.object({
            code: z.enum(docs.map(({ code }) => code)),
            message: documented(z.string(), {
              description: "For people; the client acts on code.",
            }),
          }),
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

// An operation description that starts with who may call it.
export function whoCanCall(caller: string, details = ""): string {
  return [`**Who can call:** ${caller}.`, details].filter(Boolean).join("\n\n");
}

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

// DECIMAL(10,2) columns come back from mysql2 as strings with two decimals
// and stay strings (models-db/requests.ts).
export const decimal = z
  .string()
  .regex(/^\d{1,8}\.\d{2}$/)
  .register(docsRegistry, {
    id: "Decimal",
    description:
      "A price as a decimal string with two decimals; never parse it into a float.",
    examples: ["45.00"],
  });

// libraries/event-entries.ts EventEntry, the public view of a job event. The
// service types `type` as a string; every event is written with a
// JOB_EVENT_TYPE. Shared by the timeline and the notification feed.
export const eventEntry = z
  .object({
    id: z.uuid(),
    type: documented(z.enum(JOB_EVENT_TYPE), {
      description: "What happened.",
    }),
    at: wallClock,
    actor: documented(z.enum(REQUEST_ACTOR_ROLE).nullable(), {
      description:
        "Who did it, as their role on the request; null when that account is gone.",
    }),
    details: documented(
      z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .nullable(),
      {
        description:
          "A few public values of the event (e.g. a price or a new time), or null.",
      }
    ),
  })
  .register(docsRegistry, { id: "EventEntry" });
sameShape<
  z.output<typeof eventEntry>,
  Omit<EventEntry, "type"> & { type: JobEventType }
>(true);

// models-db/users.ts PublicUser; controllers/auth.ts and controllers/users.ts.
export const publicUser = z
  .object({
    id: z.uuid(),
    fullName: documented(z.string(), { examples: ["Rana Khoury"] }),
    email: documented(z.string(), { examples: ["customer@example.com"] }),
    phone: documented(z.string(), {
      description:
        "The user's own phone. A provider's phone is shown to their customers so the app can call them; a customer's never is.",
      examples: ["+961 3 123 456"],
    }),
    avatarUrl: z.string().nullable(),
    isProvider: documented(z.boolean(), {
      description:
        "True when the user also has a provider profile (registered with becomeProvider).",
    }),
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
