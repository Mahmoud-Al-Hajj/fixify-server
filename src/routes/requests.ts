import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import {
  validateBody,
  validateQuery,
  validateParams,
} from "../middlewares/validate";
import {
  createRequestSchema,
  listRequestsQuerySchema,
  requestIdParamsSchema,
} from "./requests.schema";
import {
  createRequestHandler,
  listRequestsHandler,
  getRequestHandler,
  rejectRequestHandler,
  cancelRequestHandler,
} from "../controllers/requests";

export const requestsRouter = Router();

requestsRouter.use(authenticate);

requestsRouter.post(
  "/",
  validateBody(createRequestSchema),
  createRequestHandler
);
requestsRouter.get(
  "/",
  validateQuery(listRequestsQuerySchema),
  listRequestsHandler
);
requestsRouter.get(
  "/:id",
  validateParams(requestIdParamsSchema),
  getRequestHandler
);
requestsRouter.post(
  "/:id/reject",
  validateParams(requestIdParamsSchema),
  rejectRequestHandler
);
requestsRouter.post(
  "/:id/cancel",
  validateParams(requestIdParamsSchema),
  cancelRequestHandler
);
