import { z } from "zod";
import { AI_STATUS } from "../constants/ai-status";
import { ERROR_CODE } from "../constants/errors";
import { MESSAGE_SENDER } from "../constants/message-sender";
import type { toMessageView } from "../controllers/intake";
import { diagnosisSchema } from "../libraries/ai/diagnosis-schema";
import type { DiagnosisView, getOwnSession } from "../libraries/intake";
import type { startAnalysis } from "../libraries/intake-analysis";
import type { IntakeSession } from "../models-db/intake";
import {
  customerTurnSchema,
  sessionIdParamsSchema,
  sessionPhotoParamsSchema,
} from "../routes/intake.schema";
import { BEARER_AUTH, errors, wallClock, whoCanCall } from "./components";
import {
  docsRegistry,
  documented,
  jsonResponse,
  multipartPhotos,
  parameters,
  sameShape,
  type Paths,
} from "./convert";

const TAGS = ["intake-sessions"];

const SESSION_ID = {
  description: "An intake session id, from POST /intake-sessions.",
  example: "00000000-0000-4000-8000-000000000001",
};

// controllers/intake.ts toMessageView: a message whose photos are the
// authenticated route that serves them.
export const messageView = z
  .object({
    id: z.number().int(),
    sender: documented(z.enum(MESSAGE_SENDER), {
      description:
        "customer: a turn the customer sent; ai: the diagnosis shown to them.",
    }),
    body: z.string().nullable(),
    createdAt: wallClock,
    photos: z.array(
      z.object({
        id: z.number().int(),
        url: documented(z.string(), {
          description: "GET this path, with the token, to load the photo.",
          examples: [
            "/intake-sessions/00000000-0000-4000-8000-000000000001/photos/1",
          ],
        }),
      })
    ),
  })
  .register(docsRegistry, { id: "IntakeMessage" });
sameShape<z.output<typeof messageView>, ReturnType<typeof toMessageView>>(true);

// What a finished diagnosis looks like; the test parses it with
// diagnosisView.
export const DIAGNOSIS_EXAMPLE = {
  title: "Leaking sink trap",
  confidence: "high",
  category: "Plumber",
  serviceType: "repair",
  durationMinutes: 60,
  explanation:
    "Water is dripping from the trap under the sink; the seal or the trap itself has failed and needs replacing.",
  isUrgent: false,
  safetyNote: null,
  suggestedParts: [{ name: "Sink trap", quantity: 1, unit: "piece" }],
  categoryId: 2,
};

// libraries/intake.ts DiagnosisView: the AI's validated output, never
// edited, plus the category id the server resolved from its name.
export const diagnosisView = diagnosisSchema
  .extend({
    categoryId: documented(z.number().int().nullable(), {
      description:
        "The diagnosed trade's id, for GET /providers; null when the diagnosis names no trade.",
    }),
  })
  .register(docsRegistry, {
    id: "Diagnosis",
    description:
      "The AI's suggestion. The customer confirms or changes the trade before booking.",
    examples: [DIAGNOSIS_EXAMPLE],
  });
sameShape<z.output<typeof diagnosisView>, DiagnosisView>(true);

const aiStatus = documented(z.enum(AI_STATUS), {
  description:
    "none: not analysed yet. pending: an analysis is running. done: diagnosis holds the result. failed: choose a category yourself.",
});

// A customer turn: multipart, so photos can travel with the text. The text
// field comes from the route schema; the photos are checked by
// middlewares/upload.ts.
const TURN_BODY = multipartPhotos(customerTurnSchema, {
  body: {
    description: "What is wrong, in any language.",
    example: "The pipe under the kitchen sink is leaking.",
  },
});

const TURN_RULES = `Send text, photos, or both; an empty turn is a 400. A session holds a limited number of photos in all: over it, 400 ${ERROR_CODE.SESSION_PHOTO_CAP_REACHED}. A photo over the size limit is a 413.`;

// controllers/intake.ts getIntakeSessionHandler. Checked against the model
// and service types; the controller's own code is not covered.
const sessionBody = z.object({
  session: z.object({
    id: z.uuid(),
    aiStatus,
    diagnosis: diagnosisView.nullable(),
    requestId: documented(z.uuid().nullable(), {
      description:
        "The request booked from this session; once set, the session takes no more messages or analyses.",
    }),
    createdAt: wallClock,
    messages: documented(z.array(messageView), {
      description: "The conversation, oldest first.",
    }),
  }),
});
sameShape<
  z.output<typeof sessionBody>,
  {
    session: Pick<
      IntakeSession,
      "id" | "aiStatus" | "requestId" | "createdAt"
    > & {
      diagnosis: Awaited<ReturnType<typeof getOwnSession>>["diagnosis"];
      messages: Array<ReturnType<typeof toMessageView>>;
    };
  }
>(true);

// controllers/intake.ts createIntakeSessionHandler.
const createdBody = z.object({
  session: z.object({ id: z.uuid(), aiStatus, createdAt: wallClock }),
});
sameShape<
  z.output<typeof createdBody>,
  { session: Pick<IntakeSession, "id" | "aiStatus" | "createdAt"> }
>(true);

// controllers/intake.ts startAnalysisHandler.
const analysisBody = z.object({ aiStatus });
sameShape<
  z.output<typeof analysisBody>,
  { aiStatus: Awaited<ReturnType<typeof startAnalysis>> }
>(true);

export const intakePaths: Paths = {
  "/intake-sessions": {
    post: {
      tags: TAGS,
      operationId: "createIntakeSession",
      summary: "Start an intake session with its first turn",
      description: whoCanCall(
        "any signed-in user (the session is theirs)",
        `Describe the problem to the AI before any job exists. ${TURN_RULES}`
      ),
      security: BEARER_AUTH,
      requestBody: TURN_BODY,
      responses: {
        201: jsonResponse("The new session", createdBody),
        ...errors(400, 401, 409, 413),
      },
    },
  },
  "/intake-sessions/{id}/messages": {
    post: {
      tags: TAGS,
      operationId: "addIntakeMessage",
      summary: "Add a customer turn",
      description: whoCanCall(
        "the session's customer",
        `${TURN_RULES} A booked session is a 409 ${ERROR_CODE.SESSION_ALREADY_BOOKED}; one with an analysis running is a 409 ${ERROR_CODE.ANALYSIS_PENDING}.`
      ),
      security: BEARER_AUTH,
      parameters: parameters("path", sessionIdParamsSchema, {
        id: SESSION_ID,
      }),
      requestBody: TURN_BODY,
      responses: {
        201: jsonResponse(
          "The stored message",
          z.object({ message: messageView })
        ),
        ...errors(400, 401, 404, 409, 413),
      },
    },
  },
  "/intake-sessions/{id}/analysis": {
    post: {
      tags: TAGS,
      operationId: "startAnalysis",
      summary: "Ask the AI for a diagnosis",
      description: whoCanCall(
        "the session's customer",
        `Starts the diagnosis in the background and answers 202 at once; poll GET /intake-sessions/{id} until aiStatus is done or failed. Needs a message with text (400 ${ERROR_CODE.SESSION_HAS_NO_TEXT}). A session gets a limited number of analyses (429 ${ERROR_CODE.ANALYSIS_CAP_REACHED}), and a customer a limited number per hour (429 ${ERROR_CODE.ANALYSIS_RATE_LIMITED}). A server without the AI configured answers 503 ${ERROR_CODE.AI_NOT_CONFIGURED}: choose a category and search instead.`
      ),
      security: BEARER_AUTH,
      parameters: parameters("path", sessionIdParamsSchema, {
        id: SESSION_ID,
      }),
      responses: {
        202: jsonResponse("The analysis started", analysisBody),
        ...errors(400, 401, 404, 409, 429, 503),
      },
    },
  },
  "/intake-sessions/{id}": {
    get: {
      tags: TAGS,
      operationId: "getIntakeSession",
      summary: "A session with its conversation and diagnosis",
      description: whoCanCall(
        "the session's customer",
        "Poll this after starting an analysis. diagnosis is set only while aiStatus is done; on failed, choose a trade from GET /categories instead. Booking from the session with the diagnosed trade (categoryId) takes its service type and duration and seeds the parts list from suggestedParts; booking with another trade, or before the diagnosis is done, takes none of them."
      ),
      security: BEARER_AUTH,
      parameters: parameters("path", sessionIdParamsSchema, {
        id: SESSION_ID,
      }),
      responses: {
        200: jsonResponse("The session", sessionBody),
        ...errors(400, 401, 404),
      },
    },
  },
  "/intake-sessions/{id}/photos/{photoId}": {
    get: {
      tags: TAGS,
      operationId: "getIntakePhoto",
      summary: "One photo from a session",
      description: whoCanCall(
        "the session's customer, or the provider assigned to the request booked from it"
      ),
      security: BEARER_AUTH,
      parameters: parameters("path", sessionPhotoParamsSchema, {
        id: SESSION_ID,
        photoId: {
          description: "A photo id, from a message's photos.",
          example: "1",
        },
      }),
      responses: {
        200: {
          description: "The photo",
          content: { "image/jpeg": {}, "image/png": {} },
        },
        ...errors(400, 401, 403, 404),
      },
    },
  },
};
