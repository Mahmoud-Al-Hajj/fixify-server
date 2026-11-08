import { z } from "zod";
import { AI_STATUS } from "../constants/ai-status";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";
import { CATEGORY_NAMES, type CategoryName } from "../constants/categories";
import { ITEM_SOURCE } from "../constants/item-source";
import { PHOTO_KIND } from "../constants/photo-kind";
import { PRICE_STATUS } from "../constants/price-status";
import {
  REQUEST_ACTOR_ROLE,
  REQUEST_STATUS,
  type RequestActorRole,
} from "../constants/request-status";
import { SERVICE_TYPE } from "../constants/service-type";
import { VISIT_STATUS } from "../constants/visit-status";
import type { toMessageView } from "../controllers/intake";
import type { toRequestPhotoView } from "../controllers/requests";
import { MAX_PHOTOS_PER_REQUEST } from "../libraries/request-photos";
import type { IssueCard } from "../libraries/requests";
import { MAX_PHOTOS } from "../middlewares/upload";
import type { RequestItem } from "../models-db/request-items";
import type { NamedRequest, Request } from "../models-db/requests";
import type { Review } from "../models-db/reviews";
import type { Visit } from "../models-db/visits";
import {
  addFollowUpVisitSchema,
  addRequestPhotosSchema,
  changeRequestedStartSchema,
  createRequestSchema,
  createReviewSchema,
  fromSearchSchema,
  fromSessionSchema,
  listRequestsQuerySchema,
  proposeQuoteSchema,
  proposeRescheduleSchema,
  requestIdParamsSchema,
  requestPhotoParamsSchema,
  saveRequestItemsSchema,
  visitIdParamsSchema,
} from "../routes/requests.schema";
import {
  BEARER_AUTH,
  decimal,
  errors,
  eventEntry,
  wallClock,
  whoCanCall,
} from "./components";
import {
  docsRegistry,
  documented,
  jsonBody,
  jsonResponse,
  multipartPhotos,
  parameters,
  sameShape,
  toSchema,
  type Operation,
  type Paths,
} from "./convert";
import { demoStart, TONY } from "./demo";
import { diagnosisView, messageView } from "./intake";

const TAGS = ["requests"];

// models-db/requests.ts Request.
const request = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    providerId: z.uuid(),
    providerPhone: documented(z.string(), {
      description:
        "The assigned provider's phone, so the customer's app can call them.",
      examples: ["+961 3 123 456"],
    }),
    categoryId: z.number().int(),
    intakeSessionId: documented(z.uuid().nullable(), {
      description:
        "The intake session it was booked from; null for a booking from search.",
    }),
    serviceType: z.enum(SERVICE_TYPE).nullable(),
    description: z.string(),
    addressText: z.string(),
    requestedStart: documented(wallClock.nullable(), {
      description:
        "The start the customer chose. Once a quote is accepted, the visits hold the real times.",
    }),
    estimatedDurationMinutes: documented(z.number().int().nullable(), {
      description: `null when not estimated; the first visit then lasts ${DEFAULT_VISIT_MINUTES} minutes.`,
    }),
    isUrgent: z.boolean(),
    status: documented(z.enum(REQUEST_STATUS), {
      description:
        "pending → scheduled (customer accepts a quote) → in_progress (provider starts) → completed (provider completes). pending can end rejected (provider) or cancelled (customer); scheduled and in_progress can be cancelled by either party.",
    }),
    price: documented(decimal.nullable(), {
      description:
        "On a pending job, the proposed price; null before a quote and after one is declined. Once accepted, the agreed price.",
    }),
    revisedPrice: documented(decimal.nullable(), {
      description:
        "A revised quote waiting for the customer while the job is in progress.",
    }),
    priceStatus: documented(z.enum(PRICE_STATUS), {
      description:
        "none → proposed → accepted or declined. A revision on a job in progress goes back to proposed.",
    }),
    paidAt: wallClock.nullable(),
    createdAt: wallClock,
    respondedAt: wallClock.nullable(),
    completedAt: wallClock.nullable(),
  })
  .register(docsRegistry, { id: "Request" });
sameShape<z.output<typeof request>, Request>(true);

// models-db/requests.ts NamedRequest. The model types categoryName as a
// string; every category name is one of CATEGORY_NAMES.
const namedRequest = request
  .extend({
    categoryName: z.enum(CATEGORY_NAMES),
    otherPartyName: documented(z.string(), {
      description: "The other party's full name.",
      examples: [TONY.name],
    }),
  })
  .register(docsRegistry, { id: "NamedRequest" });
type NamedRequestAsServed = Omit<NamedRequest, "categoryName"> & {
  categoryName: CategoryName;
};
sameShape<z.output<typeof namedRequest>, NamedRequestAsServed>(true);

// controllers/requests.ts toVisitView: a visit without its request and
// provider ids, with proposedBy as a role. Checked against the model type;
// the controller's own code is not covered.
const visit = z
  .object({
    id: z.uuid(),
    status: z.enum(VISIT_STATUS),
    scheduledStart: wallClock,
    scheduledEnd: wallClock,
    actualStart: wallClock.nullable(),
    proposedStart: documented(wallClock.nullable(), {
      description: "The new start of an open reschedule proposal, or null.",
    }),
    proposedBy: documented(z.enum(REQUEST_ACTOR_ROLE).nullable(), {
      description:
        "Who proposed it: the other party accepts or declines, the proposer may withdraw.",
    }),
  })
  .register(docsRegistry, { id: "Visit" });
type VisitView = Omit<Visit, "requestId" | "providerId" | "proposedBy"> & {
  proposedBy: RequestActorRole | null;
};
sameShape<z.output<typeof visit>, VisitView>(true);

// controllers/requests.ts listRequestsHandler. Checked against the model
// types; the controller's own code is not covered.
const requestListItem = namedRequest
  .extend({
    nextVisit: documented(visit.nullable(), {
      description: "The next visit that is not done or cancelled, or null.",
    }),
  })
  .register(docsRegistry, { id: "RequestListItem" });
sameShape<
  z.output<typeof requestListItem>,
  NamedRequestAsServed & { nextVisit: VisitView | null }
>(true);

// controllers/requests.ts toRequestDetailsView: every
// visit action. Checked against the model types; the controller's own code
// is not covered.
const requestDetails = z
  .object({
    request: namedRequest.extend({
      visits: z.array(visit),
      hasReview: z.boolean(),
    }),
  })
  .register(docsRegistry, { id: "RequestDetails" });
sameShape<
  z.output<typeof requestDetails>,
  {
    request: NamedRequestAsServed & { visits: VisitView[]; hasReview: boolean };
  }
>(true);

// models-db/request-items.ts RequestItem.
const requestItem = z
  .object({
    id: z.uuid(),
    name: documented(z.string(), { examples: ["Sink trap"] }),
    quantity: z.number().int(),
    unit: z.string().nullable(),
    estimatedUnitPrice: decimal.nullable(),
    source: documented(z.enum(ITEM_SOURCE), {
      description:
        "ai: suggested by the diagnosis; provider: added or edited by the provider.",
    }),
  })
  .register(docsRegistry, { id: "RequestItem" });
sameShape<z.output<typeof requestItem>, RequestItem>(true);

// controllers/requests.ts getRequestHandler: RequestDetails plus the parts
// list and the reason for an open revised quote. Only GET /requests/:id
// serves it.
const requestDetailsWithReason = z
  .object({
    request: requestDetails.shape.request.extend({
      items: documented(z.array(requestItem), {
        description:
          "The job's parts list, same shape and order as issueCard.items. Empty when there are no parts.",
      }),
      revisionReason: documented(z.string().nullable(), {
        description:
          "Why the provider revised the quote, while the revision waits for the customer (job in_progress, priceStatus proposed, revisedPrice set). null otherwise, including after it is accepted or declined.",
        examples: ["The valve is corroded and has to be replaced too."],
      }),
    }),
  })
  .register(docsRegistry, { id: "RequestDetailsWithReason" });
sameShape<
  z.output<typeof requestDetailsWithReason>,
  {
    request: NamedRequestAsServed & {
      visits: VisitView[];
      hasReview: boolean;
      revisionReason: string | null;
      items: RequestItem[];
    };
  }
>(true);

// models-db/reviews.ts Review.
const review = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    rating: z.number().int(),
    comment: z.string().nullable(),
    createdAt: wallClock,
  })
  .register(docsRegistry, { id: "Review" });
sameShape<z.output<typeof review>, Review>(true);

// libraries/requests.ts IssueCard, its messages mapped by toMessageView
// (controllers/requests.ts getIssueCardHandler).
const issueCard = z
  .object({
    request,
    aiStatus: documented(z.enum(AI_STATUS).nullable(), {
      description: "null for a request booked from search.",
    }),
    diagnosis: diagnosisView.nullable(),
    isLate: documented(z.boolean(), {
      description:
        "The diagnosis finished after the booking, so it seeded no parts.",
    }),
    messages: documented(z.array(messageView), {
      description: "The customer's intake conversation; empty after search.",
    }),
    items: z.array(requestItem),
  })
  .register(docsRegistry, { id: "IssueCard" });
sameShape<
  z.output<typeof issueCard>,
  Omit<IssueCard, "messages"> & {
    messages: Array<ReturnType<typeof toMessageView>>;
  }
>(true);

// controllers/requests.ts toRequestPhotoView: a job photo whose url is the
// authenticated route that serves it.
const requestPhoto = z
  .object({
    id: z.uuid(),
    kind: documented(z.enum(PHOTO_KIND), {
      description: "before or after the work, or extra.",
    }),
    url: documented(z.string(), {
      description: "GET this path, with the token, to load the photo.",
      examples: [
        "/requests/00000000-0000-4000-8000-000000000001/photos/00000000-0000-4000-8000-000000000001",
      ],
    }),
    createdAt: wallClock,
  })
  .register(docsRegistry, { id: "RequestPhoto" });
sameShape<z.output<typeof requestPhoto>, ReturnType<typeof toRequestPhotoView>>(
  true
);

const photosBody = z.object({ photos: z.array(requestPhoto) });

const requestBody = z.object({ request });

const REQUEST_ID_DOC = {
  description: "A request id, from POST /requests or GET /requests.",
  example: "00000000-0000-4000-8000-000000000001",
};
const REQUEST_ID = parameters("path", requestIdParamsSchema, {
  id: REQUEST_ID_DOC,
});
const VISIT_IDS = parameters("path", visitIdParamsSchema, {
  id: REQUEST_ID_DOC,
  visitId: {
    description: "A visit id, from the request's visits.",
    example: "00000000-0000-4000-8000-000000000001",
  },
});

const ON_REQUEST = { tags: TAGS, security: BEARER_AUTH } as const;

// A status change with no body: the response is the updated request.
function transition(
  operationId: string,
  summary: string,
  who: string,
  details: string
): Operation {
  return {
    ...ON_REQUEST,
    operationId,
    summary,
    description: whoCanCall(who, details),
    parameters: REQUEST_ID,
    responses: {
      200: jsonResponse("The updated request", requestBody),
      ...errors(400, 401, 403, 404, 409),
    },
  };
}

// A reschedule answer with no body: the response is the request's details.
function rescheduleAnswer(
  operationId: string,
  summary: string,
  who: string,
  details: string
): Operation {
  return {
    ...ON_REQUEST,
    operationId,
    summary,
    description: whoCanCall(who, details),
    parameters: VISIT_IDS,
    responses: {
      200: jsonResponse("The request with its visits", requestDetails),
      ...errors(400, 401, 403, 404, 409),
    },
  };
}

const BOOKING = {
  providerId: TONY.id,
  categoryId: 2,
  addressText: "Hamra, Bliss Street, building 12, 3rd floor",
  requestedStart: demoStart(0),
};

export const requestsPaths: Paths = {
  "/requests": {
    post: {
      ...ON_REQUEST,
      operationId: "createRequest",
      summary: "Book a provider",
      description: whoCanCall(
        "any signed-in user, as the customer (not with themselves)",
        "Two shapes. From search: send description, estimatedDurationMinutes and optionally serviceType. From an intake session: send intakeSessionId and none of those three; the server takes them from the session and its diagnosis. requestedStart must be in the future: pick one from GET /providers/{id}/slots. The request starts pending; nothing is reserved until the customer accepts a quote. A provider who is not accepting jobs is a 409; a session already booked is a 409."
      ),
      requestBody: jsonBody(createRequestSchema, {
        shownAs: {
          oneOf: [
            {
              title: "From search",
              ...toSchema(fromSearchSchema, "input"),
            },
            {
              title: "From an intake session",
              ...toSchema(fromSessionSchema, "input"),
            },
          ],
        },
        examples: {
          search: {
            summary: `From search: ${TONY.name}, plumber`,
            value: {
              ...BOOKING,
              description: "The pipe under the kitchen sink is leaking.",
              estimatedDurationMinutes: 60,
              isUrgent: false,
            },
          },
          session: {
            summary: "From an intake session",
            description:
              "Replace intakeSessionId with your session's id (POST /intake-sessions).",
            value: {
              ...BOOKING,
              intakeSessionId: "00000000-0000-4000-8000-000000000001",
            },
          },
        },
      }),
      responses: {
        201: jsonResponse("The new request", requestBody),
        ...errors(400, 401, 404, 409, 413),
      },
    },
    get: {
      ...ON_REQUEST,
      operationId: "listRequests",
      summary: "The signed-in user's requests",
      description: whoCanCall(
        "any signed-in user",
        "role=customer: the requests they booked; role=provider: the requests assigned to them. Unknown query parameters are a 400."
      ),
      parameters: parameters("query", listRequestsQuerySchema, {
        role: {
          description: "Which side of the requests to list.",
          example: REQUEST_ACTOR_ROLE.CUSTOMER,
        },
      }),
      responses: {
        200: jsonResponse(
          "The requests",
          z.object({ requests: z.array(requestListItem) })
        ),
        ...errors(400, 401),
      },
    },
  },
  "/requests/{id}": {
    get: {
      ...ON_REQUEST,
      operationId: "getRequest",
      summary: "A request with its visits and parts list",
      description: whoCanCall(
        "the request's customer or provider",
        "Includes the job's parts list (items), the same list the provider sees on the issue card."
      ),
      parameters: REQUEST_ID,
      responses: {
        200: jsonResponse("The request", requestDetailsWithReason),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  "/requests/{id}/issue-card": {
    get: {
      ...ON_REQUEST,
      operationId: "getIssueCard",
      summary: "What the provider reads about the job",
      description: whoCanCall(
        "the assigned provider",
        "The request, the customer's intake conversation and its diagnosis, and the parts list."
      ),
      parameters: REQUEST_ID,
      responses: {
        200: jsonResponse("The issue card", z.object({ issueCard })),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  "/requests/{id}/timeline": {
    get: {
      ...ON_REQUEST,
      operationId: "getRequestTimeline",
      summary: "Everything that happened on a request",
      description: whoCanCall(
        "the request's customer or provider",
        "Oldest first."
      ),
      parameters: REQUEST_ID,
      responses: {
        200: jsonResponse(
          "The timeline",
          z.object({ timeline: z.array(eventEntry) })
        ),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  "/requests/{id}/reject": {
    post: transition(
      "rejectRequest",
      "Turn a job down",
      "the assigned provider",
      "Only while pending."
    ),
  },
  "/requests/{id}/cancel": {
    post: transition(
      "cancelRequest",
      "Cancel a job",
      "the customer while pending; either party once scheduled or in progress",
      "Cancels every open visit, which frees its slot, and withdraws a revised quote that is waiting; the agreed price stays."
    ),
  },
  "/requests/{id}/start": {
    post: transition(
      "startRequest",
      "Start the next visit",
      "the assigned provider",
      "On a scheduled job this starts the job; on a job in progress it starts the follow-up visit. Only one visit is in progress at a time."
    ),
  },
  "/requests/{id}/complete": {
    post: transition(
      "completeRequest",
      "Complete the job",
      "the assigned provider",
      "Only while in progress and with no revised quote waiting."
    ),
  },
  "/requests/{id}/mark-paid": {
    post: transition(
      "markRequestPaid",
      "Record the cash payment",
      "the assigned provider",
      "Only once completed, and only once."
    ),
  },
  "/requests/{id}/quote": {
    post: {
      ...ON_REQUEST,
      operationId: "proposeQuote",
      summary: "Propose a price",
      description: whoCanCall(
        "the assigned provider",
        'On a pending job: the quote, with no reason. On a job in progress: a revised quote, with a reason; the agreed price stays until the customer accepts. "Price must be greater than 0".'
      ),
      parameters: REQUEST_ID,
      requestBody: jsonBody(proposeQuoteSchema, {
        examples: {
          quote: {
            summary: "A quote (pending job)",
            value: { price: "45.00" },
          },
          revised: {
            summary: "A revised quote (job in progress)",
            value: {
              price: "60.00",
              reason: "The trap was cracked and needs replacing.",
            },
          },
        },
        fields: {
          price: "Up to 8 digits and 2 decimals, as a string.",
          reason: "Required for a revised quote, refused otherwise.",
        },
      }),
      responses: {
        200: jsonResponse("The updated request", requestBody),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/quote/decline": {
    post: transition(
      "declineQuote",
      "Decline the proposed price",
      "the customer",
      "On a pending job the price is cleared and the provider may propose again. Declining a revised quote keeps the agreed price."
    ),
  },
  "/requests/{id}/quote/accept": {
    post: transition(
      "acceptQuote",
      "Accept the proposed price",
      "the customer",
      "On a pending job this schedules it and books the first visit at requestedStart; if that slot was taken meanwhile, it is a 409: change requestedStart and accept again. On a job in progress it makes the revised price the agreed one."
    ),
  },
  "/requests/{id}/requested-start": {
    post: {
      ...ON_REQUEST,
      operationId: "changeRequestedStart",
      summary: "Choose another start time",
      description: whoCanCall(
        "the customer",
        "Only while pending. The time must be in the future and fit the provider's working hours; it reserves nothing, and a proposed quote stands. Use it when accepting a quote says the slot was taken."
      ),
      parameters: REQUEST_ID,
      requestBody: jsonBody(changeRequestedStartSchema, {
        examples: {
          later: {
            summary: `Another morning in ${TONY.name}'s hours`,
            value: { requestedStart: demoStart(1) },
          },
        },
      }),
      responses: {
        200: jsonResponse("The updated request", requestBody),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/review": {
    post: {
      ...ON_REQUEST,
      operationId: "createReview",
      summary: "Review a completed job",
      description: whoCanCall(
        "the customer",
        "Only once the job is completed, and once per request."
      ),
      parameters: REQUEST_ID,
      requestBody: jsonBody(createReviewSchema, {
        examples: {
          review: {
            summary: "Five stars",
            value: { rating: 5, comment: "Quick, tidy and on time." },
          },
        },
        fields: { rating: "1 to 5 stars." },
      }),
      responses: {
        201: jsonResponse("The review", z.object({ review })),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/items": {
    put: {
      ...ON_REQUEST,
      operationId: "saveRequestItems",
      summary: "Save the parts list",
      description: whoCanCall(
        "the assigned provider",
        'Send the whole list: items with an id are kept and updated, items without one are added, and items left out are removed. "Each item id may appear only once".'
      ),
      parameters: REQUEST_ID,
      requestBody: jsonBody(saveRequestItemsSchema, {
        examples: {
          parts: {
            summary: "Two parts",
            value: {
              items: [
                {
                  name: "Sink trap",
                  quantity: 1,
                  unit: "piece",
                  estimatedUnitPrice: "12.50",
                },
                { name: "Teflon tape", quantity: 2, unit: "roll" },
              ],
            },
          },
        },
        fields: {
          items:
            "Up to 50. Keep an existing item by sending its id (from the issue card).",
        },
      }),
      responses: {
        200: jsonResponse(
          "The parts list now",
          z.object({ items: z.array(requestItem) })
        ),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/visits": {
    post: {
      ...ON_REQUEST,
      operationId: "addFollowUpVisit",
      summary: "Add a follow-up visit",
      description: whoCanCall(
        "the assigned provider",
        "Only while the job is in progress. Finishes the visit in progress and books the next one; a start that overlaps another of the provider's visits is a 409. Start the new visit later with POST /requests/{id}/start."
      ),
      parameters: REQUEST_ID,
      requestBody: jsonBody(addFollowUpVisitSchema, {
        examples: {
          followUp: {
            summary: "Come back for 90 minutes",
            value: { start: demoStart(1), durationMinutes: 90 },
          },
        },
        fields: { durationMinutes: "15 to 1440." },
      }),
      responses: {
        201: jsonResponse("The request with its visits", requestDetails),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/photos": {
    post: {
      ...ON_REQUEST,
      operationId: "addRequestPhotos",
      summary: "Add job photos",
      description: whoCanCall(
        "the assigned provider",
        `Up to ${MAX_PHOTOS} photos per upload, all of one kind, while the job is scheduled, in progress or completed (a pending, rejected or cancelled job is a 409). A request holds at most ${MAX_PHOTOS_PER_REQUEST} photos (400 over it). Each upload shows on the timeline and in the customer's notifications. Photos cannot be deleted.`
      ),
      parameters: REQUEST_ID,
      requestBody: multipartPhotos(addRequestPhotosSchema, {
        kind: {
          description: "before or after the work, or extra.",
          example: PHOTO_KIND.BEFORE,
        },
      }),
      responses: {
        201: jsonResponse("The photos just added", photosBody),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
    get: {
      ...ON_REQUEST,
      operationId: "listRequestPhotos",
      summary: "The job photos",
      description: whoCanCall(
        "the request's customer or provider",
        "Oldest first."
      ),
      parameters: REQUEST_ID,
      responses: {
        200: jsonResponse("The photos", photosBody),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  "/requests/{id}/photos/{photoId}": {
    get: {
      ...ON_REQUEST,
      operationId: "getRequestPhoto",
      summary: "One job photo",
      description: whoCanCall("the request's customer or provider"),
      parameters: parameters("path", requestPhotoParamsSchema, {
        id: REQUEST_ID_DOC,
        photoId: {
          description: "A photo id, from GET /requests/{id}/photos.",
          example: "00000000-0000-4000-8000-000000000001",
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
  "/requests/{id}/visits/{visitId}/reschedule": {
    post: {
      ...ON_REQUEST,
      operationId: "proposeReschedule",
      summary: "Propose a new start for a visit",
      description: whoCanCall(
        "the request's customer or provider",
        "For a scheduled visit while the job is scheduled or in progress; one open proposal per visit. A customer's time must fit the provider's working hours. The visit keeps its length; the other party accepts or declines."
      ),
      parameters: VISIT_IDS,
      requestBody: jsonBody(proposeRescheduleSchema, {
        examples: {
          move: {
            summary: "Move it to another morning",
            value: { start: demoStart(2) },
          },
        },
      }),
      responses: {
        200: jsonResponse("The request with its visits", requestDetails),
        ...errors(400, 401, 403, 404, 409, 413),
      },
    },
  },
  "/requests/{id}/visits/{visitId}/reschedule/accept": {
    post: rescheduleAnswer(
      "acceptReschedule",
      "Accept a proposed new start",
      "the other party (not the proposer)",
      "Moves the visit; a time that has passed, or a slot that is taken, is a 409."
    ),
  },
  "/requests/{id}/visits/{visitId}/reschedule/decline": {
    post: rescheduleAnswer(
      "declineReschedule",
      "Decline a proposed new start",
      "the other party (not the proposer)",
      "The visit keeps its time."
    ),
  },
  "/requests/{id}/visits/{visitId}/reschedule/withdraw": {
    post: rescheduleAnswer(
      "withdrawReschedule",
      "Withdraw your proposal",
      "the party who proposed it",
      "The visit keeps its time."
    ),
  },
};
