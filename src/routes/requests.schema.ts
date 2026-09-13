import { z } from "zod";
import { SERVICE_TYPE } from "../constants/service-type";
import { REQUEST_ACTOR_ROLE } from "../libraries/request-state-machine";

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
  requestedStart: localDateTime.nullable().default(null),
  estimatedDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(1440)
    .nullable()
    .default(null),
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

export const requestIdParamsSchema = z.object({
  id: z.uuid(),
});
export type RequestIdParams = z.infer<typeof requestIdParamsSchema>;
