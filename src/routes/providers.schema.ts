import { z } from "zod";
import { requireAtLeastOneField } from "./partial-update.schema";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";

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
  area: z.string().trim().min(1).max(80).optional(),
  durationMinutes,
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
    area: z.string().trim().min(1).max(80).nullable().optional(),
  })
);
export type UpdateOwnProviderBody = z.infer<typeof updateOwnProviderSchema>;

export const replaceOwnCategoriesSchema = z.object({
  categoryIds: z.array(z.number().int().positive().max(65535)).min(1).max(50),
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
