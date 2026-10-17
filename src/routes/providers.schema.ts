import { z } from "zod";
import { requireAtLeastOneField } from "./partial-update.schema";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";
import { PROVIDER_SORT } from "../constants/provider-sort";
import { DISTRICT_NAMES } from "../constants/districts";
import { PRICE } from "./requests.schema";

// Strict, like listRequestsQuerySchema: an unsupported filter must fail loudly
// rather than be dropped.
// Job length for slot suggestions, when the customer has no estimate.
const durationMinutes = z
  .string()
  .regex(/^\d+$/, "Expected a whole number of minutes")
  .transform(Number)
  .pipe(z.number().int().min(15).max(1440))
  .default(DEFAULT_VISIT_MINUTES);

export const listProvidersQuerySchema = z.strictObject({
  // Parsed from the raw string rather than coerced: coercion turns a missing
  // parameter into NaN, and the error then says "received NaN".
  categoryId: z
    .string()
    .regex(/^\d+$/, "Expected a positive whole number")
    .transform(Number)
    .pipe(z.number().int().positive().max(65535)),
  // One of the fixed districts; searching an unknown one is a 400, not an
  // empty list.
  area: z.enum(DISTRICT_NAMES).optional(),
  durationMinutes,
  sort: z.enum(PROVIDER_SORT).default(PROVIDER_SORT.RATING),
});
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;

export const providerSlotsQuerySchema = z.strictObject({ durationMinutes });
export type ProviderSlotsQuery = z.infer<typeof providerSlotsQuerySchema>;

// Strict so a misspelled field (e.g. "isAcepting") is a 400, not a silent 200
// that changed nothing. Omitted fields stay as they are; null clears one.
export const updateOwnProviderSchema = requireAtLeastOneField(
  z.strictObject({
    isAccepting: z.boolean().optional(),
    bio: z.string().trim().min(1).max(1000).nullable().optional(),
    yearsExperience: z.number().int().min(0).max(70).nullable().optional(),
    area: z.enum(DISTRICT_NAMES).nullable().optional(),
  })
);
export type UpdateOwnProviderBody = z.infer<typeof updateOwnProviderSchema>;

// The provider's whole set of trades, each with an optional "from" price.
// Omitted or null means no rate; PUT replaces the set, so leaving a rate out
// clears it. Normalised to two decimals, like estimatedUnitPrice.
export const replaceOwnCategoriesSchema = z.object({
  categories: z
    .array(
      z.object({
        categoryId: z.number().int().positive().max(65535),
        baseRate: z
          .string()
          .regex(
            PRICE,
            "Rate must be a non-negative decimal with at most 8 digits and 2 decimals"
          )
          .transform((value) => Number(value).toFixed(2))
          .nullable()
          .optional()
          .transform((value) => value ?? null),
      })
    )
    .min(1)
    .max(50)
    .refine(
      (items) =>
        new Set(items.map((item) => item.categoryId)).size === items.length,
      { message: "Each categoryId may appear only once" }
    ),
});
export type ReplaceOwnCategoriesBody = z.infer<
  typeof replaceOwnCategoriesSchema
>;

const HOUR_MINUTE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const replaceOwnAvailabilitySchema = z.object({
  availability: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6),
          startTime: z.string().regex(HOUR_MINUTE, "Expected HH:MM"),
          endTime: z.string().regex(HOUR_MINUTE, "Expected HH:MM"),
        })
        .refine((h) => h.endTime > h.startTime, {
          message: "endTime must be after startTime",
        })
    )
    .max(21),
});
export type ReplaceOwnAvailabilityBody = z.infer<
  typeof replaceOwnAvailabilitySchema
>;

export const providerIdParamsSchema = z.object({
  id: z.uuid(),
});
export type ProviderIdParams = z.infer<typeof providerIdParamsSchema>;
