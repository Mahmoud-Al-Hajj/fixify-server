import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody, validate } from "../middlewares/validate";
import {
  listProvidersQuerySchema,
  providerIdParamsSchema,
  updateOwnProviderSchema,
  replaceOwnCategoriesSchema,
  replaceOwnAvailabilitySchema,
} from "./providers.schema";
import {
  listProvidersHandler,
  getProviderHandler,
  updateOwnProviderHandler,
  replaceOwnCategoriesHandler,
  replaceOwnAvailabilityHandler,
} from "../controllers/providers";

export const providersRouter = Router();

providersRouter.use(authenticate);

providersRouter.get(
  "/",
  validate("query", listProvidersQuerySchema),
  listProvidersHandler
);
// /me routes are registered before /:id so "me" is never read as a provider id.
providersRouter.patch(
  "/me",
  validateBody(updateOwnProviderSchema),
  updateOwnProviderHandler
);
providersRouter.put(
  "/me/categories",
  validateBody(replaceOwnCategoriesSchema),
  replaceOwnCategoriesHandler
);
providersRouter.put(
  "/me/availability",
  validateBody(replaceOwnAvailabilitySchema),
  replaceOwnAvailabilityHandler
);
providersRouter.get(
  "/:id",
  validate("params", providerIdParamsSchema),
  getProviderHandler
);
