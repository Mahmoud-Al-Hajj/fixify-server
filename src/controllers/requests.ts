import type { Request, Response } from "express";
import * as requestsService from "../libraries/requests";
import * as quotesService from "../libraries/quotes";
import * as reviewsService from "../libraries/reviews";
import * as visitsService from "../libraries/visits";
import { RESCHEDULE_ACTION } from "../libraries/visit-rules";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";
import { requireUser } from "../middlewares/authenticate";
import type { QueryLocals, ParamsLocals } from "../middlewares/validate";
import type { Visit } from "../models-db/visits";
import type { Request as RequestRecord } from "../models-db/requests";
import { toMessageView } from "./intake";
import type {
  AddFollowUpVisitBody,
  ChangeRequestedStartBody,
  CreateRequestBody,
  CreateReviewBody,
  ListRequestsQuery,
  ProposeQuoteBody,
  ProposeRescheduleBody,
  RequestIdParams,
  SaveRequestItemsBody,
  VisitIdParams,
} from "../routes/requests.schema";

export async function createRequestHandler(
  req: Request,
  res: Response
): Promise<void> {
  const customer = requireUser(req);
  const body = req.body as CreateRequestBody;
  // Only the search shape has a description (routes/requests.schema.ts).
  const request =
    "description" in body
      ? await requestsService.createRequest({
          customerId: customer.id,
          ...body,
        })
      : await requestsService.createRequestFromSession({
          customerId: customer.id,
          ...body,
        });
  res.status(201).json({ request });
}

// A visit nested under its request: requestId and providerId are dropped
// because the enclosing request already carries them. proposedBy is the
// proposer's role on the request, not their user id.
function toVisitView(visit: Visit, request: RequestRecord) {
  return {
    id: visit.id,
    status: visit.status,
    scheduledStart: visit.scheduledStart,
    scheduledEnd: visit.scheduledEnd,
    actualStart: visit.actualStart,
    proposedStart: visit.proposedStart,
    proposedBy:
      visit.proposedBy === null
        ? null
        : visit.proposedBy === request.customerId
          ? REQUEST_ACTOR_ROLE.CUSTOMER
          : REQUEST_ACTOR_ROLE.PROVIDER,
  };
}

// The shape of GET /requests/:id, shared by the visit actions.
function toRequestDetailsView({
  request,
  visits,
  hasReview,
}: {
  request: RequestRecord;
  visits: Visit[];
  hasReview: boolean;
}) {
  return {
    request: {
      ...request,
      visits: visits.map((visit) => toVisitView(visit, request)),
      hasReview,
    },
  };
}

export async function listRequestsHandler(
  req: Request,
  res: Response<unknown, QueryLocals<ListRequestsQuery>>
): Promise<void> {
  const user = requireUser(req);
  let items;
  if (res.locals.query.role === REQUEST_ACTOR_ROLE.CUSTOMER) {
    items = await requestsService.listRequestsForCustomer(user.id);
  } else {
    items = await requestsService.listRequestsForProvider(user.id);
  }
  const requests = items.map(({ request, nextVisit }) => ({
    ...request,
    nextVisit: nextVisit === null ? null : toVisitView(nextVisit, request),
  }));
  res.status(200).json({ requests });
}

export async function rejectRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.rejectRequest(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function cancelRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.cancelRequest(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function startRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.startRequest(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function completeRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.completeRequest(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function markRequestPaidHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.markRequestPaid(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function proposeQuoteHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { price, reason } = req.body as ProposeQuoteBody;
  const request = await quotesService.proposeQuote(
    res.locals.params.id,
    user.id,
    price,
    reason ?? null
  );
  res.status(200).json({ request });
}

export async function declineQuoteHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await quotesService.declineQuote(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function changeRequestedStartHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { requestedStart } = req.body as ChangeRequestedStartBody;
  const request = await requestsService.changeRequestedStart(
    res.locals.params.id,
    user.id,
    requestedStart
  );
  res.status(200).json({ request });
}

export async function acceptQuoteHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await quotesService.acceptQuote(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}

export async function getRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const details = await requestsService.getRequestForActor(
    res.locals.params.id,
    user.id
  );
  res.status(200).json(toRequestDetailsView(details));
}

export async function proposeRescheduleHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<VisitIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { start } = req.body as ProposeRescheduleBody;
  const { id, visitId } = res.locals.params;
  const details = await visitsService.proposeReschedule(
    id,
    visitId,
    user.id,
    start
  );
  res.status(200).json(toRequestDetailsView(details));
}

export async function acceptRescheduleHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<VisitIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { id, visitId } = res.locals.params;
  const details = await visitsService.acceptReschedule(id, visitId, user.id);
  res.status(200).json(toRequestDetailsView(details));
}

export async function declineRescheduleHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<VisitIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { id, visitId } = res.locals.params;
  const details = await visitsService.closeReschedule(
    RESCHEDULE_ACTION.DECLINE,
    id,
    visitId,
    user.id
  );
  res.status(200).json(toRequestDetailsView(details));
}

export async function withdrawRescheduleHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<VisitIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { id, visitId } = res.locals.params;
  const details = await visitsService.closeReschedule(
    RESCHEDULE_ACTION.WITHDRAW,
    id,
    visitId,
    user.id
  );
  res.status(200).json(toRequestDetailsView(details));
}

export async function createReviewHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { rating, comment } = req.body as CreateReviewBody;
  const review = await reviewsService.createReview(
    res.locals.params.id,
    user.id,
    { rating, comment }
  );
  res.status(201).json({ review });
}

export async function getIssueCardHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { request, aiStatus, diagnosis, isLate, messages, items } =
    await requestsService.getIssueCard(res.locals.params.id, user.id);
  const sessionId = request.intakeSessionId;
  res.status(200).json({
    issueCard: {
      request,
      aiStatus,
      diagnosis,
      isLate,
      messages: sessionId
        ? messages.map((message) => toMessageView(sessionId, message))
        : [],
      items,
    },
  });
}

export async function saveRequestItemsHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { items } = req.body as SaveRequestItemsBody;
  res.status(200).json({
    items: await requestsService.saveRequestItems(
      res.locals.params.id,
      user.id,
      items
    ),
  });
}

export async function addFollowUpVisitHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const { start, durationMinutes } = req.body as AddFollowUpVisitBody;
  const details = await visitsService.addFollowUpVisit(
    res.locals.params.id,
    user.id,
    start,
    durationMinutes
  );
  res.status(201).json(toRequestDetailsView(details));
}

export async function getRequestTimelineHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const timeline = await requestsService.getRequestTimeline(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ timeline });
}
