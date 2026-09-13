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
  proposeQuoteSchema,
  requestIdParamsSchema,
} from "./requests.schema";
import {
  createRequestHandler,
  listRequestsHandler,
  getRequestHandler,
  rejectRequestHandler,
  cancelRequestHandler,
  proposeQuoteHandler,
  declineQuoteHandler,
  acceptQuoteHandler,
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
requestsRouter.post(
  "/:id/quote",
  validateParams(requestIdParamsSchema),
  validateBody(proposeQuoteSchema),
  proposeQuoteHandler
);
requestsRouter.post(
  "/:id/quote/decline",
  validateParams(requestIdParamsSchema),
  declineQuoteHandler
);
requestsRouter.post(
  "/:id/quote/accept",
  validateParams(requestIdParamsSchema),
  acceptQuoteHandler
);
