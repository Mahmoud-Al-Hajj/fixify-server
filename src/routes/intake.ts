import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { uploadPhotos } from "../middlewares/upload";
import { analysisRateLimiter } from "../middlewares/rate-limit";
import { validateBody, validate } from "../middlewares/validate";
import {
  customerTurnSchema,
  sessionIdParamsSchema,
  sessionPhotoParamsSchema,
} from "./intake.schema";
import {
  createIntakeSessionHandler,
  addCustomerMessageHandler,
  getIntakeSessionHandler,
  getIntakePhotoHandler,
  startAnalysisHandler,
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

intakeRouter.post(
  "/:id/analysis",
  analysisRateLimiter,
  validate("params", sessionIdParamsSchema),
  startAnalysisHandler
);

intakeRouter.get(
  "/:id",
  validate("params", sessionIdParamsSchema),
  getIntakeSessionHandler
);

intakeRouter.get(
  "/:id/photos/:photoId",
  validate("params", sessionPhotoParamsSchema),
  getIntakePhotoHandler
);
