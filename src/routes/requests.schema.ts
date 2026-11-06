import { z } from "zod";
import { SERVICE_TYPE } from "../constants/service-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";

export const LOCAL_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?$/;
const LOCAL_DATETIME_MESSAGE =
  "Expected a local date-time YYYY-MM-DDTHH:mm[:ss[.SSS]] with no timezone offset";

// Beirut wall-clock digits with no offset, in the same shape the API returns
// times (YYYY-MM-DDTHH:mm:ss.SSS), so any returned time can be sent back
// unchanged. Built with Date.UTC because the mysql2 write path encodes a Date
// through its UTC getters (see insertRequest); a Date built from local
// components would be shifted. Also used by notifications.schema.ts.
export const localDateTime = z.string().transform((value, ctx) => {
  if (LOCAL_DATETIME.test(value)) {
    // The regex allows exactly 16, 19 or 23 characters.
    const full =
      value.length === 16
        ? `${value}:00.000`
        : value.length === 19
          ? `${value}.000`
          : value;
    const year = Number(full.slice(0, 4));
    const date = new Date(
      Date.UTC(
        year,
        Number(full.slice(5, 7)) - 1,
        Number(full.slice(8, 10)),
        Number(full.slice(11, 13)),
        Number(full.slice(14, 16)),
        Number(full.slice(17, 19)),
        Number(full.slice(20, 23))
      )
    );
    // The round-trip rejects values Date.UTC silently rolls over (Feb 30,
    // 24:00) or remaps (years 0-99); 1000 is the DATETIME lower bound.
    if (year >= 1000 && date.toISOString().slice(0, 23) === full) {
      return date;
    }
  }
  ctx.issues.push({
    code: "custom",
    message: LOCAL_DATETIME_MESSAGE,
    input: value,
  });
  return z.NEVER;
});

const bookingBase = {
  providerId: z.uuid(),
  categoryId: z.number().int().positive().max(65535),
  addressText: z.string().trim().min(1).max(300),
  // Required: accepting a quote creates the first visit from it.
  requestedStart: localDateTime,
  isUrgent: z.boolean().default(false),
};

// Plain category search: the client describes the job itself. Not strict, as
// before. It never sees an intakeSessionId: that key selects the other shape.
export const fromSearchSchema = z.object({
  ...bookingBase,
  serviceType: z.enum(SERVICE_TYPE).nullable().default(null),
  description: z.string().trim().min(1).max(2000),
  estimatedDurationMinutes: z.number().int().min(15).max(1440),
});

// Booked from an intake session: the server derives service type, duration
// and description (docs/ai-plan.md §13), so sending any of them is a 400.
export const fromSessionSchema = z.strictObject({
  ...bookingBase,
  intakeSessionId: z.uuid(),
});

// Which shape applies is decided by whether intakeSessionId is present, and
// only that shape is validated, so an error names the field that failed
// rather than "(root): Invalid input" from a union where neither matched.
export const createRequestSchema = z.unknown().transform((body, ctx) => {
  const shape =
    typeof body === "object" && body !== null && "intakeSessionId" in body
      ? fromSessionSchema
      : fromSearchSchema;
  const result = shape.safeParse(body);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.issues.push({
        code: "custom",
        message: issue.message,
        path: issue.path,
        input: body,
      });
    }
    return z.NEVER;
  }
  return result.data;
});
export type CreateRequestBody = z.infer<typeof createRequestSchema>;

// Strict: an unsupported or misspelled filter must fail loudly rather than
// be dropped, or the client believes it filtered when it did not.
export const listRequestsQuerySchema = z.strictObject({
  role: z.enum(REQUEST_ACTOR_ROLE),
});
export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;

// DECIMAL(10,2) carried as a string end to end, never parsed to a number. The
// digit limits cap it at 99999999.99; the second check rejects zero. Also the
// shape of a provider's base rate (providers.schema.ts).
export const PRICE = /^\d{1,8}(\.\d{1,2})?$/;

export const proposeQuoteSchema = z.object({
  price: z
    .string()
    .regex(
      PRICE,
      "Price must be a decimal with at most 8 digits and 2 decimals"
    )
    .refine((value) => /[1-9]/.test(value), "Price must be greater than 0"),
  // Required for a revised quote (request in progress), rejected otherwise.
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ProposeQuoteBody = z.infer<typeof proposeQuoteSchema>;

// The provider's whole parts list: items with an id are kept (and updated),
// items without one are new, and existing items left out are removed.
export const saveRequestItemsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid().optional(),
        name: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(1).max(65535),
        unit: z.string().trim().min(1).max(20).nullable().default(null),
        // Normalised to two decimals so "6.5" and the stored "6.50" compare
        // equal; the digit limits keep it exact.
        estimatedUnitPrice: z
          .string()
          .regex(
            PRICE,
            "Price must be a decimal with at most 8 digits and 2 decimals"
          )
          .transform((value) => Number(value).toFixed(2))
          .nullable()
          .default(null),
      })
    )
    .max(50)
    .refine(
      (items) => {
        const ids = items.flatMap((item) => (item.id ? [item.id] : []));
        return new Set(ids).size === ids.length;
      },
      { message: "Each item id may appear only once" }
    ),
});
export type SaveRequestItemsBody = z.infer<typeof saveRequestItemsSchema>;

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(1000).nullable().default(null),
});
export type CreateReviewBody = z.infer<typeof createReviewSchema>;

export const requestIdParamsSchema = z.object({
  id: z.uuid(),
});
export type RequestIdParams = z.infer<typeof requestIdParamsSchema>;

export const visitIdParamsSchema = z.object({
  id: z.uuid(),
  visitId: z.uuid(),
});
export type VisitIdParams = z.infer<typeof visitIdParamsSchema>;

// The new start for a visit, Beirut wall-clock like requestedStart; the visit
// keeps its length.
export const proposeRescheduleSchema = z.object({
  start: localDateTime,
});
export type ProposeRescheduleBody = z.infer<typeof proposeRescheduleSchema>;

// The customer's new time for a pending job, Beirut wall-clock like
// requestedStart at booking.
export const changeRequestedStartSchema = z.object({
  requestedStart: localDateTime,
});
export type ChangeRequestedStartBody = z.infer<
  typeof changeRequestedStartSchema
>;

// A follow-up visit the provider adds to a job in progress: its start, Beirut
// wall-clock, and its length (the provider knows how long it needs).
export const addFollowUpVisitSchema = z.object({
  start: localDateTime,
  durationMinutes: z.number().int().min(15).max(1440),
});
export type AddFollowUpVisitBody = z.infer<typeof addFollowUpVisitSchema>;
