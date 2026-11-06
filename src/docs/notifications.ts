import { z } from "zod";
import { CATEGORY_NAMES, type CategoryName } from "../constants/categories";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";
import type {
  getFeed,
  markRead,
  Notification,
} from "../libraries/notifications";
import { markNotificationsReadSchema } from "../routes/notifications.schema";
import { BEARER_AUTH, errors, wallClock } from "./components";
import {
  docsRegistry,
  jsonBody,
  jsonResponse,
  sameShape,
  type Paths,
} from "./convert";

const TAGS = ["notifications"];

// libraries/notifications.ts Notification: the public event view
// (libraries/event-entries.ts EventEntry) plus the request's names. The
// service types `type` and `categoryName` as strings; every event is written
// with a JOB_EVENT_TYPE and every category name is one of CATEGORY_NAMES.
const notification = z
  .object({
    id: z.uuid(),
    type: z.enum(JOB_EVENT_TYPE),
    at: wallClock,
    actor: z.enum(REQUEST_ACTOR_ROLE).nullable(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .nullable(),
    requestId: z.uuid(),
    categoryName: z.enum(CATEGORY_NAMES),
    otherPartyName: z.string(),
    unread: z.boolean(),
  })
  .register(docsRegistry, { id: "Notification" });

// controllers/notifications.ts getNotificationsHandler: the service's result
// as is.
const feed = z.object({
  unreadCount: z.number().int(),
  notifications: z.array(notification),
});
type Feed = Awaited<ReturnType<typeof getFeed>>;
sameShape<
  z.output<typeof feed>,
  Omit<Feed, "notifications"> & {
    notifications: Array<
      Omit<Notification, "type" | "categoryName"> & {
        type: JobEventType;
        categoryName: CategoryName;
      }
    >;
  }
>(true);

// controllers/notifications.ts markNotificationsReadHandler.
const unread = z.object({ unreadCount: z.number().int() });
sameShape<
  z.output<typeof unread>,
  { unreadCount: Awaited<ReturnType<typeof markRead>> }
>(true);

export const notificationsPaths: Paths = {
  "/notifications": {
    get: {
      tags: TAGS,
      operationId: "getNotifications",
      summary: "The signed-in user's notification feed",
      description:
        "The newest events on the user's requests made by the other party, newest first. unread: newer than the last readUpTo.",
      security: BEARER_AUTH,
      responses: {
        200: jsonResponse("The feed", feed),
        ...errors(401),
      },
    },
  },
  "/notifications/read": {
    post: {
      tags: TAGS,
      operationId: "markNotificationsRead",
      summary: "Mark notifications read up to a time",
      description:
        "readUpTo: the `at` of the newest notification the app showed, sent back unchanged. The read mark only moves forward. Unknown fields are a 400.",
      security: BEARER_AUTH,
      requestBody: jsonBody(markNotificationsReadSchema),
      responses: {
        200: jsonResponse("The unread count after marking", unread),
        ...errors(400, 401, 413),
      },
    },
  },
};
