import type { Request, Response } from "express";
import * as requestsService from "../libraries/requests";
import { REQUEST_ACTOR_ROLE } from "../libraries/request-state-machine";
import { requireUser } from "../middlewares/authenticate";
import type { QueryLocals, ParamsLocals } from "../middlewares/validate";
import type {
  CreateRequestBody,
  ListRequestsQuery,
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

export async function listRequestsHandler(
  req: Request,
  res: Response<unknown, QueryLocals<ListRequestsQuery>>
): Promise<void> {
  const user = requireUser(req);
  let requests;
  if (res.locals.query.role === REQUEST_ACTOR_ROLE.CUSTOMER) {
    requests = await requestsService.listRequestsForCustomer(user.id);
  } else {
    requests = await requestsService.listRequestsForProvider(user.id);
  }
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

export async function getRequestHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<RequestIdParams>>
): Promise<void> {
  const user = requireUser(req);
  const request = await requestsService.getRequestForActor(
    res.locals.params.id,
    user.id
  );
  res.status(200).json({ request });
}
