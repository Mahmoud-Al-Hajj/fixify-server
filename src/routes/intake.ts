import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { uploadPhotos } from "../middlewares/upload";
import { validateBody, validate } from "../middlewares/validate";
import { customerTurnSchema, sessionIdParamsSchema } from "./intake.schema";
import {
  createIntakeSessionHandler,
  addCustomerMessageHandler,
} from "../controllers/intake";

export const intakeRouter = Router();

intakeRouter.use(authenticate);

intakeRouter.post(
  "/",
  uploadPhotos,
  validateBody(customerTurnSchema),
  createIntakeSessionHandler
);

intakeRouter.post(
  "/:id/messages",
  validate("params", sessionIdParamsSchema),
  uploadPhotos,
  validateBody(customerTurnSchema),
  addCustomerMessageHandler
);
