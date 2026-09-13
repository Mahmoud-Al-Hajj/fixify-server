import type { Request, Response } from "express";
import * as requestsService from "../libraries/requests";
import * as quotesService from "../libraries/quotes";
import * as reviewsService from "../libraries/reviews";
import { REQUEST_ACTOR_ROLE } from "../libraries/request-state-machine";
import { requireUser } from "../middlewares/authenticate";
import type { QueryLocals, ParamsLocals } from "../middlewares/validate";
import type { Visit } from "../models-db/visits";
import type {
  CreateRequestBody,
  CreateReviewBody,
  ListRequestsQuery,
  ProposeQuoteBody,
  RequestIdParams,
} from "../routes/requests.schema";

export async function createRequestHandler(
  req: Request,
  res: Response
): Promise<void> {
  const customer = requireUser(req);
  const body = req.body as CreateRequestBody;
  const request = await requestsService.createRequest({
    customerId: customer.id,
    providerId: body.providerId,
    categoryId: body.categoryId,
    serviceType: body.serviceType,
    description: body.description,
    addressText: body.addressText,
    requestedStart: body.requestedStart,
    estimatedDurationMinutes: body.estimatedDurationMinutes,
    isUrgent: body.isUrgent,
  });
  res.status(201).json({ request });
}

// A visit nested under its request: requestId and providerId are dropped
// because the enclosing request already carries them.
function toVisitView(visit: Visit) {
  return {
    id: visit.id,
    status: visit.status,
    scheduledStart: visit.scheduledStart,
    scheduledEnd: visit.scheduledEnd,
    actualStart: visit.actualStart,
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
    nextVisit: nextVisit === null ? null : toVisitView(nextVisit),
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
  const { price } = req.body as ProposeQuoteBody;
  const request = await quotesService.proposeQuote(
    res.locals.params.id,
    user.id,
    price
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
  const { request, visits, hasReview } =
    await requestsService.getRequestForActor(res.locals.params.id, user.id);
  res.status(200).json({
    request: { ...request, visits: visits.map(toVisitView), hasReview },
  });
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
