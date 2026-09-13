import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import {
  validateBody,
  validateQuery,
  validateParams,
} from "../middlewares/validate";
import {
  createRequestSchema,
  createReviewSchema,
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
  startRequestHandler,
  completeRequestHandler,
  markRequestPaidHandler,
  proposeQuoteHandler,
  declineQuoteHandler,
  acceptQuoteHandler,
  createReviewHandler,
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
  "/:id/start",
  validateParams(requestIdParamsSchema),
  startRequestHandler
);
requestsRouter.post(
  "/:id/complete",
  validateParams(requestIdParamsSchema),
  completeRequestHandler
);
requestsRouter.post(
  "/:id/mark-paid",
  validateParams(requestIdParamsSchema),
  markRequestPaidHandler
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
requestsRouter.post(
  "/:id/review",
  validateParams(requestIdParamsSchema),
  validateBody(createReviewSchema),
  createReviewHandler
);
