import { randomUUID } from "node:crypto";
import { pool } from "../models-db/pool";
import {
  insertRequest,
  findRequestById,
  listRequestsForCustomer as listRequestsForCustomerModel,
  listRequestsForProvider as listRequestsForProviderModel,
  type Request,
  type InsertRequestInput,
} from "../models-db/requests";
import {
  findProviderAcceptance,
  providerAcceptsCategory,
} from "../models-db/providers";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../constants/errors";
import {
  REQUEST_ACTOR_ROLE,
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
  if (!provider.isAccepting) {
    throw new ConflictError(
      "This provider is not currently accepting requests"
    );
  }

  const offersCategory = await providerAcceptsCategory(
    input.providerId,
    input.categoryId
  );
  if (!offersCategory) {
    throw new ValidationError("Provider does not offer this category");
  }

  const id = randomUUID();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await insertRequest(conn, { id, ...input });
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
