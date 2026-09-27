import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { uploadPhotos } from "../middlewares/upload";
import { validateBody } from "../middlewares/validate";
import { customerTurnSchema } from "./intake.schema";
import { createIntakeSessionHandler } from "../controllers/intake";

export const intakeRouter = Router();

intakeRouter.use(authenticate);

intakeRouter.post(
  "/",
  uploadPhotos,
  validateBody(customerTurnSchema),
  createIntakeSessionHandler
);
