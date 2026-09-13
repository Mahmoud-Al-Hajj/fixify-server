import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import {
  validateBody,
  validateQuery,
  validateParams,
} from "../middlewares/validate";
import {
  listProvidersQuerySchema,
  providerIdParamsSchema,
  updateOwnProviderSchema,
  replaceOwnCategoriesSchema,
} from "./providers.schema";
import {
  listProvidersHandler,
  getProviderHandler,
  updateOwnProviderHandler,
  replaceOwnCategoriesHandler,
} from "../controllers/providers";

export const providersRouter = Router();

providersRouter.use(authenticate);

providersRouter.get(
  "/",
  validateQuery(listProvidersQuerySchema),
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
providersRouter.get(
  "/:id",
  validateParams(providerIdParamsSchema),
  getProviderHandler
);
