import { Router } from "express";
import { authenticate } from "../middlewares/authenticate";
import { validateBody, validate } from "../middlewares/validate";
import {
  createRequestSchema,
  createReviewSchema,
  saveRequestItemsSchema,
  listRequestsQuerySchema,
  proposeQuoteSchema,
  requestIdParamsSchema,
  visitIdParamsSchema,
  proposeRescheduleSchema,
  addFollowUpVisitSchema,
} from "./requests.schema";
import {
  createRequestHandler,
  listRequestsHandler,
  getRequestHandler,
  getIssueCardHandler,
  getRequestTimelineHandler,
  rejectRequestHandler,
  cancelRequestHandler,
  startRequestHandler,
  completeRequestHandler,
  markRequestPaidHandler,
  proposeQuoteHandler,
  declineQuoteHandler,
  acceptQuoteHandler,
  createReviewHandler,
  saveRequestItemsHandler,
  proposeRescheduleHandler,
  acceptRescheduleHandler,
  declineRescheduleHandler,
  withdrawRescheduleHandler,
  addFollowUpVisitHandler,
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
requestsRouter.get(
  "/:id/timeline",
  validate("params", requestIdParamsSchema),
  getRequestTimelineHandler
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
requestsRouter.put(
  "/:id/items",
  validate("params", requestIdParamsSchema),
  validateBody(saveRequestItemsSchema),
  saveRequestItemsHandler
);
requestsRouter.post(
  "/:id/visits/:visitId/reschedule",
  validate("params", visitIdParamsSchema),
  validateBody(proposeRescheduleSchema),
  proposeRescheduleHandler
);
requestsRouter.post(
  "/:id/visits/:visitId/reschedule/accept",
  validate("params", visitIdParamsSchema),
  acceptRescheduleHandler
);
requestsRouter.post(
  "/:id/visits/:visitId/reschedule/decline",
  validate("params", visitIdParamsSchema),
  declineRescheduleHandler
);
requestsRouter.post(
  "/:id/visits/:visitId/reschedule/withdraw",
  validate("params", visitIdParamsSchema),
  withdrawRescheduleHandler
);
requestsRouter.post(
  "/:id/visits",
  validate("params", requestIdParamsSchema),
  validateBody(addFollowUpVisitSchema),
  addFollowUpVisitHandler
);
