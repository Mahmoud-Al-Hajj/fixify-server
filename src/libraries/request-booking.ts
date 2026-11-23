import { randomUUID } from "node:crypto";
import { withTransaction } from "../models-db/pool";
import {
  insertRequest,
  type Request,
  type InsertRequestInput,
} from "../models-db/requests";
import {
  findProviderAcceptance,
  providerAcceptsCategory,
  lockProviderForUpdate,
} from "../models-db/providers";
import { insertJobEvent } from "../models-db/job-events";
import { beirutNow } from "../models-db/format-datetime";
import {
  listIntakeMessages,
  lockIntakeSession,
  readSessionFreeze,
} from "../models-db/intake";
import { findCategoryName } from "../models-db/categories";
import { insertRequestItems } from "../models-db/request-items";
import { ITEM_SOURCE } from "../constants/item-source";
import { MESSAGE_SENDER } from "../constants/message-sender";
import { BOOKING_SOURCE } from "../constants/booking";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  ERROR_CODE,
} from "../constants/errors";
import { currentDiagnosis } from "./intake";
import { buildDescription, deriveBookingFields } from "./booking-from-session";
import { assertRequestTimeFree } from "./slot-reservation";
import { rereadRequest } from "./request-access";

// Creating a request (POST /requests), in two shapes: from category search,
// where the client sends the description, or from an intake session, where
// the service type, duration, description and parts come from the session and
// its diagnosis. Either way the request starts pending and holds no slot; the
// time is only checked against the provider's open visits and this
// customer's own pending requests to them (assertRequestTimeFree).

export type CreateRequestInput = Omit<
  InsertRequestInput,
  "id" | "intakeSessionId"
>;

// The checks every booking runs before its transaction, whichever path it
// came through.
async function assertBookable(
  input: Pick<
    CreateRequestInput,
    "customerId" | "providerId" | "categoryId" | "requestedStart"
  >
): Promise<void> {
  if (input.customerId === input.providerId) {
    throw new ValidationError("You cannot request service from yourself");
  }
  if (input.requestedStart !== null && input.requestedStart <= beirutNow()) {
    throw new ValidationError("requestedStart must be in the future");
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
}

export async function createRequest(
  input: CreateRequestInput
): Promise<Request> {
  await assertBookable(input);
  const id = randomUUID();

  await withTransaction(async (conn) => {
    await assertRequestTimeFree(conn, {
      customerId: input.customerId,
      providerId: input.providerId,
      requestedStart: input.requestedStart,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      excludeRequestId: null,
    });
    await insertRequest(conn, { id, ...input, intakeSessionId: null });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: id,
      actorUserId: input.customerId,
      eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
      payload: null,
    });
  });

  return rereadRequest(id);
}

export type BookFromSessionInput = Pick<
  CreateRequestInput,
  | "customerId"
  | "providerId"
  | "categoryId"
  | "addressText"
  | "latitude"
  | "longitude"
  | "addressDetails"
  | "requestedStart"
  | "isUrgent"
> & { intakeSessionId: string };

// docs/ai-plan.md §13.3. The session lock is the transaction's first read, so
// a message or booking committed while waiting is seen. The service type,
// duration, description and parts come from the session, not the client.
export async function createRequestFromSession(
  input: BookFromSessionInput
): Promise<Request> {
  await assertBookable(input);
  const categoryName = await findCategoryName(input.categoryId);
  if (categoryName === null) {
    throw new Error("A category the provider offers could not be read");
  }
  const id = randomUUID();

  await withTransaction(async (conn) => {
    const session = await lockIntakeSession(conn, input.intakeSessionId);
    if (!session || session.customerId !== input.customerId) {
      throw new NotFoundError("Intake session not found");
    }
    // Before the first plain read (readSessionFreeze), so the overlap checks
    // below see every booking committed while we waited. Lock order: session,
    // then provider.
    await lockProviderForUpdate(conn, input.providerId);
    if ((await readSessionFreeze(conn, input.intakeSessionId)).booked) {
      throw new ConflictError(
        "This problem has already been booked; describe a new one in a new session",
        ERROR_CODE.SESSION_ALREADY_BOOKED
      );
    }
    const messages = await listIntakeMessages(input.intakeSessionId, conn);
    const description = buildDescription(
      messages
        .filter((message) => message.sender === MESSAGE_SENDER.CUSTOMER)
        .map((message) => message.body)
    );
    if (description === null) {
      throw new ValidationError(
        "Describe the problem in words before booking",
        ERROR_CODE.SESSION_HAS_NO_TEXT
      );
    }
    const derived = deriveBookingFields(
      {
        aiStatus: session.aiStatus,
        diagnosis: currentDiagnosis({ id: input.intakeSessionId, ...session }),
      },
      categoryName
    );
    await assertRequestTimeFree(conn, {
      customerId: input.customerId,
      providerId: input.providerId,
      requestedStart: input.requestedStart,
      estimatedDurationMinutes: derived.estimatedDurationMinutes,
      excludeRequestId: null,
    });
    await insertRequest(conn, {
      ...input,
      id,
      serviceType: derived.serviceType,
      description,
      estimatedDurationMinutes: derived.estimatedDurationMinutes,
    });
    await insertRequestItems(
      conn,
      id,
      derived.parts.map((part) => ({
        id: randomUUID(),
        name: part.name,
        quantity: part.quantity,
        unit: part.unit,
        estimatedUnitPrice: null,
        source: ITEM_SOURCE.AI,
      }))
    );
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: id,
      actorUserId: input.customerId,
      eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
      payload: {
        source: BOOKING_SOURCE.INTAKE,
        intakeSessionId: input.intakeSessionId,
        aiStatusAtBooking: session.aiStatus,
        usedDiagnosis: derived.usedDiagnosis,
        partsSeeded: derived.parts.length,
      },
    });
  });

  return rereadRequest(id);
}
