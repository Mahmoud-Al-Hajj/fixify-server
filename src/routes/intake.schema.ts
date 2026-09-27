import { z } from "zod";

// A customer turn's text; its photos arrive as multipart files alongside it.
export const customerTurnSchema = z.object({
  body: z.string().trim().min(1).max(2000).optional(),
});
export type CustomerTurnBody = z.infer<typeof customerTurnSchema>;
