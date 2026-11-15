import { z } from "zod";
import { localDateTime } from "./requests.schema";

// readUpTo: the `at` of the newest notification the app showed, sent back
// unchanged. Strict, so a misspelled field is a 400.
export const markNotificationsReadSchema = z.strictObject({
  readUpTo: localDateTime,
});
export type MarkNotificationsReadBody = z.infer<
  typeof markNotificationsReadSchema
>;

export const notificationIdParamsSchema = z.object({
  id: z.uuid(),
});
export type NotificationIdParams = z.infer<typeof notificationIdParamsSchema>;
