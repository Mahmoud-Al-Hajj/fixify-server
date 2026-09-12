import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_STATUS,
  ALLOWED_TRANSITIONS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError, ForbiddenError } from "../constants/errors";
import {
  assertRequestTransition,
  REQUEST_ACTOR_ROLE,
  TRANSITION_ACTORS,
  type RequestActorRole,
} from "./request-state-machine";

interface Case {
  from: RequestStatus;
  to: RequestStatus;
  actor: RequestActorRole;
}

const LEGAL_CASES: Case[] = [
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.SCHEDULED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.REJECTED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.SCHEDULED,
    to: REQUEST_STATUS.IN_PROGRESS,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.SCHEDULED,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.SCHEDULED,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.IN_PROGRESS,
    to: REQUEST_STATUS.COMPLETED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.IN_PROGRESS,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.IN_PROGRESS,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
];

for (const { from, to, actor } of LEGAL_CASES) {
  test(`${from} -> ${to} by ${actor} is allowed`, () => {
    assert.doesNotThrow(() => assertRequestTransition(from, to, actor));
  });
}

const WRONG_ROLE_CASES: Case[] = [
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.SCHEDULED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.REJECTED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.PENDING,
    to: REQUEST_STATUS.CANCELLED,
    actor: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    from: REQUEST_STATUS.SCHEDULED,
    to: REQUEST_STATUS.IN_PROGRESS,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    from: REQUEST_STATUS.IN_PROGRESS,
    to: REQUEST_STATUS.COMPLETED,
    actor: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
];

for (const { from, to, actor } of WRONG_ROLE_CASES) {
  test(`${from} -> ${to} by ${actor} throws ForbiddenError`, () => {
    try {
      assertRequestTransition(from, to, actor);
      assert.fail("expected assertRequestTransition to throw");
    } catch (err) {
      assert.ok(err instanceof ForbiddenError);
      assert.equal(err.code, "FORBIDDEN");
    }
  });
}

interface IllegalEdge {
  from: RequestStatus;
  to: RequestStatus;
}

const ILLEGAL_EDGES: IllegalEdge[] = [
  { from: REQUEST_STATUS.COMPLETED, to: REQUEST_STATUS.PENDING },
  { from: REQUEST_STATUS.REJECTED, to: REQUEST_STATUS.PENDING },
  { from: REQUEST_STATUS.CANCELLED, to: REQUEST_STATUS.PENDING },
  { from: REQUEST_STATUS.PENDING, to: REQUEST_STATUS.IN_PROGRESS },
  { from: REQUEST_STATUS.PENDING, to: REQUEST_STATUS.COMPLETED },
  { from: REQUEST_STATUS.SCHEDULED, to: REQUEST_STATUS.PENDING },
  { from: REQUEST_STATUS.SCHEDULED, to: REQUEST_STATUS.COMPLETED },
  { from: REQUEST_STATUS.IN_PROGRESS, to: REQUEST_STATUS.SCHEDULED },
  { from: REQUEST_STATUS.IN_PROGRESS, to: REQUEST_STATUS.REJECTED },
];

for (const { from, to } of ILLEGAL_EDGES) {
  for (const actor of Object.values(REQUEST_ACTOR_ROLE)) {
    test(`${from} -> ${to} by ${actor} throws InvalidTransitionError`, () => {
      try {
        assertRequestTransition(from, to, actor);
        assert.fail("expected assertRequestTransition to throw");
      } catch (err) {
        assert.ok(err instanceof InvalidTransitionError);
        assert.equal(err.code, "INVALID_TRANSITION");
      }
    });
  }
}

test("an illegal transition throws InvalidTransitionError even when the actor is also wrong", () => {
  try {
    assertRequestTransition(
      REQUEST_STATUS.PENDING,
      REQUEST_STATUS.COMPLETED,
      REQUEST_ACTOR_ROLE.CUSTOMER
    );
    assert.fail("expected assertRequestTransition to throw");
  } catch (err) {
    assert.ok(err instanceof InvalidTransitionError);
    assert.ok(!(err instanceof ForbiddenError));
  }
});

test("TRANSITION_ACTORS and ALLOWED_TRANSITIONS encode the same edges", () => {
  for (const from of Object.values(REQUEST_STATUS)) {
    const legalTargets = ALLOWED_TRANSITIONS[from];
    const actorTargets = Object.keys(
      TRANSITION_ACTORS[from]
    ) as RequestStatus[];

    for (const to of legalTargets) {
      const actors = TRANSITION_ACTORS[from][to];
      assert.ok(
        actors && actors.length > 0,
        `ALLOWED_TRANSITIONS has ${from} -> ${to} but TRANSITION_ACTORS has no actors for it`
      );
    }

    for (const to of actorTargets) {
      assert.ok(
        legalTargets.includes(to),
        `TRANSITION_ACTORS has ${from} -> ${to} but that is not a legal edge in ALLOWED_TRANSITIONS`
      );
    }
  }
});
