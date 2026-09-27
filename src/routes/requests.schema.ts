import { z } from "zod";
import { SERVICE_TYPE } from "../constants/service-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const LOCAL_DATETIME_MESSAGE =
  "Expected a local date-time YYYY-MM-DDTHH:mm[:ss] with no timezone offset";

// Beirut wall-clock digits with no offset. Built with Date.UTC because the
// mysql2 write path encodes a Date through its UTC getters (see
// insertRequest); a Date built from local components would be shifted.
const localDateTime = z.string().transform((value, ctx) => {
  if (LOCAL_DATETIME.test(value)) {
    const withSeconds = value.length === 16 ? `${value}:00` : value;
    const year = Number(withSeconds.slice(0, 4));
    const date = new Date(
      Date.UTC(
        year,
        Number(withSeconds.slice(5, 7)) - 1,
        Number(withSeconds.slice(8, 10)),
        Number(withSeconds.slice(11, 13)),
        Number(withSeconds.slice(14, 16)),
        Number(withSeconds.slice(17, 19))
      )
    );
    // The round-trip rejects values Date.UTC silently rolls over (Feb 30,
    // 24:00) or remaps (years 0-99); 1000 is the DATETIME lower bound.
    if (year >= 1000 && date.toISOString().slice(0, 19) === withSeconds) {
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

export const createRequestSchema = z.object({
  providerId: z.uuid(),
  categoryId: z.number().int().positive().max(65535),
  serviceType: z.enum(SERVICE_TYPE).nullable().default(null),
  description: z.string().trim().min(1).max(2000),
  addressText: z.string().trim().min(1).max(300),
  // Both required: accepting a quote creates the first visit from them, so a
  // request without them could be quoted but never accepted.
  requestedStart: localDateTime,
  estimatedDurationMinutes: z.number().int().min(15).max(1440),
  isUrgent: z.boolean().default(false),
});
export type CreateRequestBody = z.infer<typeof createRequestSchema>;

// Strict: an unsupported or misspelled filter must fail loudly rather than
// be dropped, or the client believes it filtered when it did not.
export const listRequestsQuerySchema = z.strictObject({
  role: z.enum(REQUEST_ACTOR_ROLE),
});
export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;

// DECIMAL(10,2) carried as a string end to end, never parsed to a number. The
// digit limits cap it at 99999999.99; the second check rejects zero.
const PRICE = /^\d{1,8}(\.\d{1,2})?$/;

export const proposeQuoteSchema = z.object({
  price: z
    .string()
    .regex(
      PRICE,
      "Price must be a decimal with at most 8 digits and 2 decimals"
    )
    .refine((value) => /[1-9]/.test(value), "Price must be greater than 0"),
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
