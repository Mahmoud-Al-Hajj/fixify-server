import { randomUUID } from "node:crypto";
import { withTransaction } from "../models-db/pool";
import {
  insertReview,
  findReviewForRequest,
  type Review,
} from "../models-db/reviews";
import { insertJobEvent } from "../models-db/job-events";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { ForbiddenError } from "../constants/errors";
import { REQUEST_ACTOR_ROLE } from "./request-state-machine";
import { loadRequestForActor } from "./requests";

export interface CreateReviewInput {
  rating: number;
  comment: string | null;
}

// Whether the request is completed, and whether it was already reviewed, are
// not checked here: trg_reviews_completed and uq_reviews_request enforce both,
// and insertReview turns either failure into a ConflictError.
export async function createReview(
  requestId: string,
  actorUserId: string,
  input: CreateReviewInput
): Promise<Review> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.CUSTOMER) {
    throw new ForbiddenError("Only the customer can review this request");
  }

  const reviewId = randomUUID();
  await withTransaction(async (conn) => {
    await insertReview(conn, {
      id: reviewId,
      requestId: request.id,
      rating: input.rating,
      comment: input.comment,
    });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.REVIEW_CREATED,
      payload: { reviewId },
    });
  });

  const created = await findReviewForRequest(request.id);
  if (!created) {
    throw new Error("Review was created but could not be re-read");
  }
  return created;
}
