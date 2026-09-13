import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError, ForbiddenError } from "../constants/errors";
import {
  REQUEST_ACTOR_ROLE,
  type RequestActorRole,
} from "./request-state-machine";
import {
  assertQuoteTransition,
  QUOTE_TRANSITIONS,
} from "./quote-state-machine";

interface Case {
  from: PriceStatus;
  to: PriceStatus;
  actor: RequestActorRole;
  requestStatus: RequestStatus;
}

function expectThrows(
  { from, to, actor, requestStatus }: Case,
  errorClass: typeof InvalidTransitionError | typeof ForbiddenError
): void {
  try {
    assertQuoteTransition(from, to, actor, requestStatus);
    assert.fail("expected assertQuoteTransition to throw");
  } catch (err) {
    assert.ok(
      err instanceof errorClass,
      `expected ${errorClass.name}, got ${String(err)}`
    );
  }
}

const { NONE, PROPOSED, ACCEPTED, DECLINED } = PRICE_STATUS;
const { CUSTOMER, PROVIDER } = REQUEST_ACTOR_ROLE;
const { PENDING, SCHEDULED, IN_PROGRESS, COMPLETED, REJECTED, CANCELLED } =
  REQUEST_STATUS;

const LEGAL_CASES: Case[] = [
  { from: NONE, to: PROPOSED, actor: PROVIDER, requestStatus: PENDING },
  { from: PROPOSED, to: ACCEPTED, actor: CUSTOMER, requestStatus: PENDING },
  { from: PROPOSED, to: ACCEPTED, actor: CUSTOMER, requestStatus: IN_PROGRESS },
  { from: PROPOSED, to: DECLINED, actor: CUSTOMER, requestStatus: PENDING },
  { from: PROPOSED, to: DECLINED, actor: CUSTOMER, requestStatus: IN_PROGRESS },
  { from: DECLINED, to: PROPOSED, actor: PROVIDER, requestStatus: PENDING },
  { from: DECLINED, to: PROPOSED, actor: PROVIDER, requestStatus: IN_PROGRESS },
  { from: ACCEPTED, to: PROPOSED, actor: PROVIDER, requestStatus: IN_PROGRESS },
];

for (const c of LEGAL_CASES) {
  test(`quote ${c.from} -> ${c.to} by ${c.actor} while ${c.requestStatus} is allowed`, () => {
    assert.doesNotThrow(() =>
      assertQuoteTransition(c.from, c.to, c.actor, c.requestStatus)
    );
  });
}

const WRONG_ROLE_CASES: Case[] = [
  { from: NONE, to: PROPOSED, actor: CUSTOMER, requestStatus: PENDING },
  { from: PROPOSED, to: ACCEPTED, actor: PROVIDER, requestStatus: PENDING },
  { from: PROPOSED, to: DECLINED, actor: PROVIDER, requestStatus: PENDING },
  { from: DECLINED, to: PROPOSED, actor: CUSTOMER, requestStatus: PENDING },
  { from: ACCEPTED, to: PROPOSED, actor: CUSTOMER, requestStatus: IN_PROGRESS },
];

for (const c of WRONG_ROLE_CASES) {
  test(`quote ${c.from} -> ${c.to} by ${c.actor} throws ForbiddenError`, () => {
    expectThrows(c, ForbiddenError);
  });
}

const ILLEGAL_EDGES: Array<{ from: PriceStatus; to: PriceStatus }> = [
  { from: NONE, to: NONE },
  { from: NONE, to: ACCEPTED },
  { from: NONE, to: DECLINED },
  { from: PROPOSED, to: NONE },
  { from: PROPOSED, to: PROPOSED },
  { from: ACCEPTED, to: NONE },
  { from: ACCEPTED, to: ACCEPTED },
  { from: ACCEPTED, to: DECLINED },
  { from: DECLINED, to: NONE },
  { from: DECLINED, to: ACCEPTED },
  { from: DECLINED, to: DECLINED },
];

for (const { from, to } of ILLEGAL_EDGES) {
  for (const actor of Object.values(REQUEST_ACTOR_ROLE)) {
    test(`quote ${from} -> ${to} by ${actor} throws InvalidTransitionError`, () => {
      expectThrows(
        { from, to, actor, requestStatus: PENDING },
        InvalidTransitionError
      );
    });
  }
}

const WRONG_REQUEST_STATUS_CASES: Case[] = [
  ...[SCHEDULED, IN_PROGRESS, COMPLETED, REJECTED, CANCELLED].map(
    (requestStatus): Case => ({
      from: NONE,
      to: PROPOSED,
      actor: PROVIDER,
      requestStatus,
    })
  ),
  ...[SCHEDULED, COMPLETED, REJECTED, CANCELLED].flatMap(
    (requestStatus): Case[] => [
      { from: PROPOSED, to: ACCEPTED, actor: CUSTOMER, requestStatus },
      { from: PROPOSED, to: DECLINED, actor: CUSTOMER, requestStatus },
      { from: DECLINED, to: PROPOSED, actor: PROVIDER, requestStatus },
    ]
  ),
  ...[PENDING, SCHEDULED, COMPLETED, REJECTED, CANCELLED].map(
    (requestStatus): Case => ({
      from: ACCEPTED,
      to: PROPOSED,
      actor: PROVIDER,
      requestStatus,
    })
  ),
];

for (const c of WRONG_REQUEST_STATUS_CASES) {
  test(`quote ${c.from} -> ${c.to} by ${c.actor} while ${c.requestStatus} throws InvalidTransitionError`, () => {
    expectThrows(c, InvalidTransitionError);
  });
}

test("an illegal quote edge throws InvalidTransitionError even when the actor is also wrong", () => {
  expectThrows(
    { from: NONE, to: ACCEPTED, actor: PROVIDER, requestStatus: PENDING },
    InvalidTransitionError
  );
});

test("a wrong actor is reported before a wrong request status", () => {
  expectThrows(
    { from: NONE, to: PROPOSED, actor: CUSTOMER, requestStatus: COMPLETED },
    ForbiddenError
  );
});

test("every quote edge allows at least one request status", () => {
  for (const from of Object.values(PRICE_STATUS)) {
    for (const [to, rule] of Object.entries(QUOTE_TRANSITIONS[from])) {
      assert.ok(
        rule && rule.requestStatuses.length > 0,
        `QUOTE_TRANSITIONS has ${from} -> ${to} with no request statuses`
      );
    }
  }
});
