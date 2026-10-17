import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody } from "../middlewares/validate";
import { markNotificationsReadSchema } from "./notifications.schema";
import {
  getNotificationsHandler,
  markNotificationsReadHandler,
} from "../controllers/notifications";

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get("/", getNotificationsHandler);
notificationsRouter.post(
  "/read",
  validateBody(markNotificationsReadSchema),
  markNotificationsReadHandler
);
