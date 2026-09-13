import { randomUUID } from "node:crypto";
import { pool } from "../models-db/pool";
import {
  insertRequest,
  findRequestById,
  updateRequestStatus,
  listRequestsForCustomer as listRequestsForCustomerModel,
  listRequestsForProvider as listRequestsForProviderModel,
  type Request,
  type InsertRequestInput,
} from "../models-db/requests";
import {
  findProviderAcceptance,
  providerAcceptsCategory,
} from "../models-db/providers";
import { insertJobEvent } from "../models-db/job-events";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidTransitionError,
} from "../constants/errors";
import {
  REQUEST_ACTOR_ROLE,
  assertRequestTransition,
  type RequestActorRole,
} from "./request-state-machine";

export type CreateRequestInput = Omit<InsertRequestInput, "id">;

export async function createRequest(
  input: CreateRequestInput
): Promise<Request> {
  if (input.customerId === input.providerId) {
    throw new ValidationError("You cannot request service from yourself");
  }

  const provider = await findProviderAcceptance(input.providerId);
  if (!provider) {
    throw new NotFoundError("Provider not found");
  }

  // The category check runs before is_accepting: a wrong category is a
  // permanent input error, a paused provider is temporary state. Reporting
  // the 409 first would send the client away to retry a request that can
  // never succeed.
  const offersCategory = await providerAcceptsCategory(
    input.providerId,
    input.categoryId
  );
  if (!offersCategory) {
    throw new ValidationError("Provider does not offer this category");
  }
  if (!provider.isAccepting) {
    throw new ConflictError(
      "This provider is not currently accepting requests"
    );
  }

  const id = randomUUID();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await insertRequest(conn, { id, ...input });
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: id,
        actorUserId: input.customerId,
        eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
        payload: null,
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  const created = await findRequestById(id);
  if (!created) {
    throw new Error("Request was created but could not be re-read");
  }
  return created;
}

export function resolveActorRole(
  request: Request,
  actorUserId: string
): RequestActorRole {
  if (request.customerId === actorUserId) {
    return REQUEST_ACTOR_ROLE.CUSTOMER;
  }
  if (request.providerId === actorUserId) {
    return REQUEST_ACTOR_ROLE.PROVIDER;
  }
  throw new ForbiddenError("You are not a party to this request");
}

export async function getRequestForActor(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  resolveActorRole(request, actorUserId);
  return request;
}

interface TransitionInput {
  requestId: string;
  actorUserId: string;
  targetStatus: RequestStatus;
  eventType: JobEventType;
  markResponded: boolean;
  // Narrower than the state machine where an action is not yet safe from
  // every status it allows. Omitted when the state machine is the only limit.
  permittedFromStatuses?: readonly RequestStatus[];
}

async function transitionRequest(input: TransitionInput): Promise<Request> {
  const request = await findRequestById(input.requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  const actorRole = resolveActorRole(request, input.actorUserId);
  assertRequestTransition(request.status, input.targetStatus, actorRole);
  if (
    input.permittedFromStatuses &&
    !input.permittedFromStatuses.includes(request.status)
  ) {
    throw new InvalidTransitionError(
      `Cannot transition request from '${request.status}' to '${input.targetStatus}'`
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const updated = await updateRequestStatus(conn, {
        id: request.id,
        fromStatus: request.status,
        toStatus: input.targetStatus,
        markResponded: input.markResponded,
      });
      if (!updated) {
        throw new InvalidTransitionError(
          "Request was changed by another action; reload it and try again"
        );
      }
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: request.id,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        payload: null,
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  const transitioned = await findRequestById(request.id);
  if (!transitioned) {
    throw new Error("Request was transitioned but could not be re-read");
  }
  return transitioned;
}

export async function rejectRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.REJECTED,
    eventType: JOB_EVENT_TYPE.REQUEST_REJECTED,
    markResponded: true,
  });
}

export async function cancelRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.CANCELLED,
    eventType: JOB_EVENT_TYPE.REQUEST_CANCELLED,
    markResponded: false,
    // Pending only until visits exist: cancelling a scheduled or in-progress
    // job must also cancel its visits to release their booked slots. Lift
    // this restriction when that is built.
    permittedFromStatuses: [REQUEST_STATUS.PENDING],
  });
}

export async function listRequestsForCustomer(
  customerId: string
): Promise<Request[]> {
  return listRequestsForCustomerModel(customerId);
}

export async function listRequestsForProvider(
  providerId: string
): Promise<Request[]> {
  return listRequestsForProviderModel(providerId);
}
