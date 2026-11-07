import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_STATUS,
  REQUEST_ACTOR_ROLE,
} from "../constants/request-status";
import { VISIT_STATUS } from "../constants/visit-status";
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  ValidationError,
} from "../constants/errors";
import {
  assertRescheduleAction,
  assertCanAddFollowUp,
  type FollowUpCheck,
  RESCHEDULE_ACTION,
  type RescheduleCheck,
} from "./visit-rules";

// Wall-clock values are Dates whose UTC fields hold the Beirut digits.
const at = (wallClock: string) => new Date(`${wallClock}Z`);
const NOW = at("2026-10-15T12:00");
const CUSTOMER = "customer-id";
const PROVIDER = "provider-id";
const OPEN = { start: at("2026-10-20T09:00"), by: PROVIDER };

// A valid accept by the customer of the provider's open proposal; each case
// changes what it needs.
const base: RescheduleCheck = {
  action: RESCHEDULE_ACTION.ACCEPT,
  requestStatus: REQUEST_STATUS.SCHEDULED,
  visitStatus: VISIT_STATUS.SCHEDULED,
  proposal: OPEN,
  actorUserId: CUSTOMER,
  now: NOW,
  newStart: null,
};

const ALLOWED: Array<[string, Partial<RescheduleCheck>]> = [
  [
    "propose by the customer",
    {
      action: RESCHEDULE_ACTION.PROPOSE,
      proposal: null,
      newStart: at("2026-10-21T10:00"),
    },
  ],
  [
    "propose by the provider",
    {
      action: RESCHEDULE_ACTION.PROPOSE,
      proposal: null,
      actorUserId: PROVIDER,
      newStart: at("2026-10-21T10:00"),
    },
  ],
  [
    "propose while the job is in progress (a follow-up visit)",
    {
      action: RESCHEDULE_ACTION.PROPOSE,
      requestStatus: REQUEST_STATUS.IN_PROGRESS,
      proposal: null,
      newStart: at("2026-10-21T10:00"),
    },
  ],
  ["accept by the other party", {}],
  ["decline by the other party", { action: RESCHEDULE_ACTION.DECLINE }],
  [
    "withdraw by the proposer",
    { action: RESCHEDULE_ACTION.WITHDRAW, actorUserId: PROVIDER },
  ],
  [
    "decline after the proposed time has passed",
    { action: RESCHEDULE_ACTION.DECLINE, now: at("2026-10-20T09:30") },
  ],
  [
    "withdraw after the proposed time has passed",
    {
      action: RESCHEDULE_ACTION.WITHDRAW,
      actorUserId: PROVIDER,
      now: at("2026-10-20T09:30"),
    },
  ],
];

for (const [name, change] of ALLOWED) {
  test(`reschedule: ${name} is allowed`, () => {
    assert.doesNotThrow(() => assertRescheduleAction({ ...base, ...change }));
  });
}

const REFUSED: Array<
  [string, Partial<RescheduleCheck>, new (...args: never[]) => Error]
> = [
  [
    "any action while the request is pending",
    { requestStatus: REQUEST_STATUS.PENDING },
    InvalidTransitionError,
  ],
  [
    "any action while the request is completed",
    { requestStatus: REQUEST_STATUS.COMPLETED },
    InvalidTransitionError,
  ],
  [
    "any action while the request is cancelled",
    { requestStatus: REQUEST_STATUS.CANCELLED },
    InvalidTransitionError,
  ],
  [
    "any action on a visit in progress",
    { visitStatus: VISIT_STATUS.IN_PROGRESS },
    InvalidTransitionError,
  ],
  [
    "any action on a done visit",
    { visitStatus: VISIT_STATUS.DONE },
    InvalidTransitionError,
  ],
  [
    "a second proposal while one is open",
    { action: RESCHEDULE_ACTION.PROPOSE, newStart: at("2026-10-21T10:00") },
    ConflictError,
  ],
  [
    "a proposal in the past",
    {
      action: RESCHEDULE_ACTION.PROPOSE,
      proposal: null,
      newStart: at("2026-10-15T11:00"),
    },
    ValidationError,
  ],
  [
    "a proposal for exactly now",
    { action: RESCHEDULE_ACTION.PROPOSE, proposal: null, newStart: NOW },
    ValidationError,
  ],
  ["accept with no open proposal", { proposal: null }, ConflictError],
  [
    "decline with no open proposal",
    { action: RESCHEDULE_ACTION.DECLINE, proposal: null },
    ConflictError,
  ],
  [
    "withdraw with no open proposal",
    {
      action: RESCHEDULE_ACTION.WITHDRAW,
      proposal: null,
      actorUserId: PROVIDER,
    },
    ConflictError,
  ],
  ["accept by the proposer", { actorUserId: PROVIDER }, ForbiddenError],
  [
    "decline by the proposer",
    { action: RESCHEDULE_ACTION.DECLINE, actorUserId: PROVIDER },
    ForbiddenError,
  ],
  [
    "withdraw by the other party",
    { action: RESCHEDULE_ACTION.WITHDRAW },
    ForbiddenError,
  ],
  [
    "accept after the proposed time has passed",
    { now: at("2026-10-20T09:30") },
    ConflictError,
  ],
  [
    "accept at exactly the proposed time",
    { now: at("2026-10-20T09:00") },
    ConflictError,
  ],
];

for (const [name, change, errorClass] of REFUSED) {
  test(`reschedule: ${name} is refused with ${errorClass.name}`, () => {
    assert.throws(
      () => assertRescheduleAction({ ...base, ...change }),
      (err: unknown) => err instanceof errorClass
    );
  });
}

// assertCanAddFollowUp: a valid follow-up by the provider while visit 1 is in
// progress; each case changes what it needs.
const followUp: FollowUpCheck = {
  requestStatus: REQUEST_STATUS.IN_PROGRESS,
  actorRole: REQUEST_ACTOR_ROLE.PROVIDER,
  visitStatuses: [VISIT_STATUS.IN_PROGRESS],
  start: at("2026-10-20T09:00"),
  now: NOW,
};

test("follow-up: the provider, one visit in progress, a future start, is allowed", () => {
  assert.doesNotThrow(() => assertCanAddFollowUp(followUp));
});

test("follow-up: earlier done or cancelled visits do not count as open", () => {
  assert.doesNotThrow(() =>
    assertCanAddFollowUp({
      ...followUp,
      visitStatuses: [
        VISIT_STATUS.DONE,
        VISIT_STATUS.CANCELLED,
        VISIT_STATUS.IN_PROGRESS,
      ],
    })
  );
});

const FOLLOW_UP_REFUSED: Array<
  [string, Partial<FollowUpCheck>, new (...args: never[]) => Error]
> = [
  [
    "by the customer",
    { actorRole: REQUEST_ACTOR_ROLE.CUSTOMER },
    ForbiddenError,
  ],
  [
    "while the request is pending",
    { requestStatus: REQUEST_STATUS.PENDING },
    InvalidTransitionError,
  ],
  [
    "while the request is scheduled",
    { requestStatus: REQUEST_STATUS.SCHEDULED },
    InvalidTransitionError,
  ],
  [
    "while the request is completed",
    { requestStatus: REQUEST_STATUS.COMPLETED },
    InvalidTransitionError,
  ],
  [
    "while the request is cancelled",
    { requestStatus: REQUEST_STATUS.CANCELLED },
    InvalidTransitionError,
  ],
  [
    "while the request is rejected",
    { requestStatus: REQUEST_STATUS.REJECTED },
    InvalidTransitionError,
  ],
  [
    "with no visit in progress",
    { visitStatuses: [VISIT_STATUS.DONE] },
    ConflictError,
  ],
  [
    "with two visits in progress",
    { visitStatuses: [VISIT_STATUS.IN_PROGRESS, VISIT_STATUS.IN_PROGRESS] },
    ConflictError,
  ],
  [
    "with a scheduled visit alongside",
    { visitStatuses: [VISIT_STATUS.IN_PROGRESS, VISIT_STATUS.SCHEDULED] },
    ConflictError,
  ],
  [
    "with a start in the past",
    { start: at("2026-10-15T11:00") },
    ValidationError,
  ],
  ["with a start of exactly now", { start: NOW }, ValidationError],
];

for (const [name, change, errorClass] of FOLLOW_UP_REFUSED) {
  test(`follow-up: ${name} is refused with ${errorClass.name}`, () => {
    assert.throws(
      () => assertCanAddFollowUp({ ...followUp, ...change }),
      (err: unknown) => err instanceof errorClass
    );
  });
}
