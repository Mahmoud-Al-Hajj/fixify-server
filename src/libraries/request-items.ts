import { randomUUID } from "node:crypto";
import { withTransaction } from "../models-db/pool";
import { lockRequestForUpdate } from "../models-db/requests";
import {
  listRequestItems,
  insertRequestItems,
  updateRequestItem,
  deleteRequestItems,
  setRequestItemOrder,
  type RequestItem,
} from "../models-db/request-items";
import { insertJobEvent } from "../models-db/job-events";
import { ITEM_SOURCE } from "../constants/item-source";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import {
  REQUEST_STATUS,
  REQUEST_ACTOR_ROLE,
  type RequestStatus,
} from "../constants/request-status";
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../constants/errors";
import { loadRequestForActor } from "./request-access";

// The job's parts list (request_items), edited only by the assigned provider
// from the issue card. Rows seeded from the AI's suggestion keep source 'ai'
// until the provider changes them.

export type RequestItemInput = Omit<RequestItem, "id" | "source"> & {
  id?: string | undefined;
};

const PARTS_EDITABLE: readonly RequestStatus[] = [
  REQUEST_STATUS.PENDING,
  REQUEST_STATUS.SCHEDULED,
  REQUEST_STATUS.IN_PROGRESS,
];

// Replaces the parts list with the provider's version. New and edited items
// are marked source = 'provider'; unchanged items keep their source. One
// job_events row records the counts, only when something changed.
export async function saveRequestItems(
  requestId: string,
  actorUserId: string,
  input: readonly RequestItemInput[]
): Promise<RequestItem[]> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError(
      "Only the assigned provider can edit the parts list"
    );
  }
  await withTransaction(async (conn) => {
    const status = await lockRequestForUpdate(conn, request.id);
    if (status === null || !PARTS_EDITABLE.includes(status)) {
      throw new ConflictError(
        "The parts list can no longer change: the request is closed"
      );
    }
    const current = new Map(
      (await listRequestItems(request.id, conn)).map((i) => [i.id, i])
    );
    const unknown = input.filter((i) => i.id && !current.has(i.id));
    if (unknown.length > 0) {
      throw new ValidationError("Item id(s) not on this request");
    }
    const kept = new Set(input.map((i) => i.id));
    const removed = [...current.keys()].filter((id) => !kept.has(id));
    const added: RequestItem[] = [];
    const updated: RequestItem[] = [];
    const order: string[] = [];
    for (const { id, ...fields } of input) {
      const before = id ? current.get(id) : undefined;
      const item = {
        ...fields,
        id: id ?? randomUUID(),
        source: ITEM_SOURCE.PROVIDER,
      };
      order.push(item.id);
      if (!before) {
        added.push(item);
      } else if (
        before.name !== item.name ||
        before.quantity !== item.quantity ||
        before.unit !== item.unit ||
        before.estimatedUnitPrice !== item.estimatedUnitPrice
      ) {
        updated.push(item);
      }
    }
    await deleteRequestItems(conn, removed);
    await insertRequestItems(conn, request.id, added);
    for (const item of updated) {
      await updateRequestItem(conn, item);
    }
    await setRequestItemOrder(conn, request.id, order);
    // A save that only reorders changes no part, so it writes no event.
    if (added.length + updated.length + removed.length === 0) return;
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.REQUEST_ITEMS_UPDATED,
      payload: {
        added: added.length,
        updated: updated.length,
        removed: removed.length,
      },
    });
  });
  return listRequestItems(request.id);
}
