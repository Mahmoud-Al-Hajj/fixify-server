import { z } from "zod";

// Strict, like listRequestsQuerySchema: an unsupported filter must fail loudly
// rather than be dropped.
export const listProvidersQuerySchema = z.strictObject({
  // Parsed from the raw string rather than coerced: coercion turns a missing
  // parameter into NaN, and the error then says "received NaN".
  categoryId: z
    .string()
    .regex(/^\d+$/, "Expected a positive whole number")
    .transform(Number)
    .pipe(z.number().int().positive().max(65535)),
  isAccepting: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;

// Strict so a misspelled field (e.g. "isAcepting") is a 400, not a silent 200
// that changed nothing. Omitted fields stay as they are; null clears one.
export const updateOwnProviderSchema = z
  .strictObject({
    isAccepting: z.boolean().optional(),
    bio: z.string().trim().min(1).max(1000).nullable().optional(),
    yearsExperience: z.number().int().min(0).max(70).nullable().optional(),
    area: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });
export type UpdateOwnProviderBody = z.infer<typeof updateOwnProviderSchema>;

export const replaceOwnCategoriesSchema = z.object({
  categoryIds: z.array(z.number().int().positive().max(65535)).min(1).max(50),
});
export type ReplaceOwnCategoriesBody = z.infer<
  typeof replaceOwnCategoriesSchema
>;

export const providerIdParamsSchema = z.object({
  id: z.uuid(),
});
export type ProviderIdParams = z.infer<typeof providerIdParamsSchema>;
