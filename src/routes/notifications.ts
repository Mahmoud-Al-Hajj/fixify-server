import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody, validate } from "../middlewares/validate";
import {
  markNotificationsReadSchema,
  notificationIdParamsSchema,
} from "./notifications.schema";
import {
  getNotificationsHandler,
  markNotificationsReadHandler,
  markNotificationReadHandler,
} from "../controllers/notifications";

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get("/", getNotificationsHandler);
notificationsRouter.post(
  "/read",
  validateBody(markNotificationsReadSchema),
  markNotificationsReadHandler
);
notificationsRouter.post(
  "/:id/read",
  validate("params", notificationIdParamsSchema),
  markNotificationReadHandler
);
