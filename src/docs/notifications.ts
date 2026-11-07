import { z } from "zod";
import { CATEGORY_NAMES, type CategoryName } from "../constants/categories";
import type { JobEventType } from "../constants/job-event-type";
import type {
  getFeed,
  markOneRead,
  markRead,
  Notification,
} from "../libraries/notifications";
import {
  markNotificationsReadSchema,
  notificationIdParamsSchema,
} from "../routes/notifications.schema";
import { BEARER_AUTH, errors, eventEntry, whoCanCall } from "./components";
import {
  docsRegistry,
  documented,
  jsonBody,
  jsonResponse,
  parameters,
  sameShape,
  type Paths,
} from "./convert";

const TAGS = ["notifications"];

// libraries/notifications.ts Notification: the public event view plus the
// request's names. The service types categoryName as a string; every
// category name is one of CATEGORY_NAMES.
const notification = eventEntry
  .extend({
    requestId: z.uuid(),
    categoryName: z.enum(CATEGORY_NAMES),
    otherPartyName: documented(z.string(), {
      description: "The other party's full name.",
      examples: ["Tony Aoun"],
    }),
    unread: documented(z.boolean(), {
      description:
        "Newer than the user's last readUpTo and not opened on its own.",
    }),
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

// controllers/notifications.ts markNotificationsReadHandler and
// markNotificationReadHandler.
const unread = z.object({ unreadCount: z.number().int() });
sameShape<
  z.output<typeof unread>,
  { unreadCount: Awaited<ReturnType<typeof markRead>> }
>(true);
sameShape<
  z.output<typeof unread>,
  { unreadCount: Awaited<ReturnType<typeof markOneRead>> }
>(true);

export const notificationsPaths: Paths = {
  "/notifications": {
    get: {
      tags: TAGS,
      operationId: "getNotifications",
      summary: "The signed-in user's notification feed",
      description: whoCanCall(
        "any signed-in user",
        "The newest events on the user's requests that the other party made, newest first."
      ),
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
      description: whoCanCall(
        "any signed-in user",
        "The read mark only moves forward. Unknown fields are a 400."
      ),
      security: BEARER_AUTH,
      requestBody: jsonBody(markNotificationsReadSchema, {
        examples: {
          readUpTo: {
            summary: "Read up to a time",
            description:
              "Replace the time with the `at` of the newest notification from GET /notifications.",
            value: { readUpTo: "2026-11-06T18:00:00.000" },
          },
        },
        fields: {
          readUpTo:
            "The `at` of the newest notification the app showed, sent back unchanged.",
        },
      }),
      responses: {
        200: jsonResponse("The unread count after marking", unread),
        ...errors(400, 401, 413),
      },
    },
  },
  "/notifications/{id}/read": {
    post: {
      tags: TAGS,
      operationId: "markNotificationRead",
      summary: "Mark one notification read",
      description: whoCanCall(
        "any signed-in user",
        "Marks only this notification read; the others keep their state. Marking it again changes nothing. A 404 when it is not in the user's feed: another user's request, or the user's own action."
      ),
      security: BEARER_AUTH,
      parameters: parameters("path", notificationIdParamsSchema, {
        id: {
          description: "A notification's `id`, from GET /notifications.",
          example: "5b1f6a1e-3c2d-4e8f-9a7b-2c4d6e8f0a1b",
        },
      }),
      responses: {
        200: jsonResponse("The unread count after marking", unread),
        ...errors(400, 401, 404),
      },
    },
  },
};
