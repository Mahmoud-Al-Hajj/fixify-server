import type { Request, Response } from "express";
import * as requestsService from "../libraries/requests";
import { requireUser } from "../middlewares/authenticate";
import type { CreateRequestBody } from "../routes/requests.schema";

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
