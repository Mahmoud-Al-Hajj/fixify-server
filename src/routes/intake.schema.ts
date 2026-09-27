import { z } from "zod";

// A customer turn's text; its photos arrive as multipart files alongside it.
export const customerTurnSchema = z.object({
  body: z.string().trim().min(1).max(2000).optional(),
});
export type CustomerTurnBody = z.infer<typeof customerTurnSchema>;

export const sessionIdParamsSchema = z.object({
  id: z.uuid(),
});
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;

export const sessionPhotoParamsSchema = z.object({
  id: z.uuid(),
  photoId: z
    .string()
    .regex(/^\d+$/, "Expected a positive whole number")
    .transform(Number),
});
export type SessionPhotoParams = z.infer<typeof sessionPhotoParamsSchema>;
