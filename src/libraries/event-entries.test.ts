import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";
import {
  PUBLIC_DETAILS,
  actorRole,
  publicDetails,
  toEventEntry,
} from "./event-entries";

const REQUEST = { customerId: "customer-id", providerId: "provider-id" };

test("request_created never exposes its intake fields", () => {
  assert.equal(
    publicDetails(JOB_EVENT_TYPE.REQUEST_CREATED, {
      source: "intake",
      intakeSessionId: "bbbbbbbb-0000-4000-8000-000000000001",
      aiStatusAtBooking: "done",
      usedDiagnosis: true,
      partsSeeded: 2,
    }),
    null
  );
});

test("a revised quote keeps revisedPrice and reason", () => {
  assert.deepEqual(
    publicDetails(JOB_EVENT_TYPE.QUOTE_PROPOSED, {
      revisedPrice: "110.00",
      reason: "Corroded pipe joint",
    }),
    { revisedPrice: "110.00", reason: "Corroded pipe joint" }
  );
});

test("unlisted keys are dropped", () => {
  assert.deepEqual(
    publicDetails(JOB_EVENT_TYPE.VISIT_ADDED, {
      visitId: "v2",
      scheduledStart: "2026-12-08T09:00:00.000",
      finishedVisitId: "v1",
      internal: "secret",
    }),
    {
      visitId: "v2",
      scheduledStart: "2026-12-08T09:00:00.000",
      finishedVisitId: "v1",
    }
  );
});

test("a reschedule keeps from and to", () => {
  assert.deepEqual(
    publicDetails(JOB_EVENT_TYPE.VISIT_RESCHEDULED, {
      visitId: "v1",
      from: "2026-11-02T09:00:00.000",
      to: "2026-11-03T08:00:00.000",
    }),
    {
      visitId: "v1",
      from: "2026-11-02T09:00:00.000",
      to: "2026-11-03T08:00:00.000",
    }
  );
});

test("no payload, nothing listed present, or an unknown type → null", () => {
  assert.equal(publicDetails(JOB_EVENT_TYPE.REQUEST_PAID, null), null);
  assert.equal(publicDetails(JOB_EVENT_TYPE.REQUEST_PAID, { other: 1 }), null);
  assert.equal(publicDetails("not_an_event", { price: "10.00" }), null);
});

test("non-plain values are not passed through", () => {
  assert.equal(
    publicDetails(JOB_EVENT_TYPE.REQUEST_PAID, { price: { nested: true } }),
    null
  );
});

test("every event type has a whitelist entry", () => {
  for (const type of Object.values(JOB_EVENT_TYPE)) {
    assert.ok(Array.isArray(PUBLIC_DETAILS[type]), type);
  }
});

test("actorRole maps the request's parties and nothing else", () => {
  assert.equal(actorRole("customer-id", REQUEST), REQUEST_ACTOR_ROLE.CUSTOMER);
  assert.equal(actorRole("provider-id", REQUEST), REQUEST_ACTOR_ROLE.PROVIDER);
  assert.equal(actorRole(null, REQUEST), null);
  assert.equal(actorRole("someone-else", REQUEST), null);
});

test("toEventEntry: the public shape, with no user id or raw payload", () => {
  assert.deepEqual(
    toEventEntry(
      {
        id: "e1",
        actorUserId: "provider-id",
        type: JOB_EVENT_TYPE.QUOTE_PROPOSED,
        payload: { price: "80.00" },
        createdAt: "2026-10-17T10:00:00.000",
      },
      REQUEST
    ),
    {
      id: "e1",
      type: JOB_EVENT_TYPE.QUOTE_PROPOSED,
      at: "2026-10-17T10:00:00.000",
      actor: REQUEST_ACTOR_ROLE.PROVIDER,
      details: { price: "80.00" },
    }
  );
});
