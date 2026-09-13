import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateQuery, validateParams } from "../middlewares/validate";
import {
  listProvidersQuerySchema,
  providerIdParamsSchema,
} from "./providers.schema";
import {
  listProvidersHandler,
  getProviderHandler,
} from "../controllers/providers";

export const providersRouter = Router();

providersRouter.use(authenticate);

providersRouter.get(
  "/",
  validateQuery(listProvidersQuerySchema),
  listProvidersHandler
);
providersRouter.get(
  "/:id",
  validateParams(providerIdParamsSchema),
  getProviderHandler
);
