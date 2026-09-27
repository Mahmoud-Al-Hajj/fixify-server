import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody, validate } from "../middlewares/validate";
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
  getIssueCardHandler,
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
  validate("query", listRequestsQuerySchema),
  listRequestsHandler
);
requestsRouter.get(
  "/:id",
  validate("params", requestIdParamsSchema),
  getRequestHandler
);
requestsRouter.get(
  "/:id/issue-card",
  validate("params", requestIdParamsSchema),
  getIssueCardHandler
);
requestsRouter.post(
  "/:id/reject",
  validate("params", requestIdParamsSchema),
  rejectRequestHandler
);
requestsRouter.post(
  "/:id/cancel",
  validate("params", requestIdParamsSchema),
  cancelRequestHandler
);
requestsRouter.post(
  "/:id/start",
  validate("params", requestIdParamsSchema),
  startRequestHandler
);
requestsRouter.post(
  "/:id/complete",
  validate("params", requestIdParamsSchema),
  completeRequestHandler
);
requestsRouter.post(
  "/:id/mark-paid",
  validate("params", requestIdParamsSchema),
  markRequestPaidHandler
);
requestsRouter.post(
  "/:id/quote",
  validate("params", requestIdParamsSchema),
  validateBody(proposeQuoteSchema),
  proposeQuoteHandler
);
requestsRouter.post(
  "/:id/quote/decline",
  validate("params", requestIdParamsSchema),
  declineQuoteHandler
);
requestsRouter.post(
  "/:id/quote/accept",
  validate("params", requestIdParamsSchema),
  acceptQuoteHandler
);
requestsRouter.post(
  "/:id/review",
  validate("params", requestIdParamsSchema),
  validateBody(createReviewSchema),
  createReviewHandler
);
