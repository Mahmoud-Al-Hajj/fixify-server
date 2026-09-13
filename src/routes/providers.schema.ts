import { z } from "zod";

// Strict, like listRequestsQuerySchema: an unsupported filter must fail loudly
// rather than be dropped.
export const listProvidersQuerySchema = z.strictObject({
  categoryId: z.coerce.number().int().positive().max(65535),
  isAccepting: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;

export const providerIdParamsSchema = z.object({
  id: z.uuid(),
});
export type ProviderIdParams = z.infer<typeof providerIdParamsSchema>;
