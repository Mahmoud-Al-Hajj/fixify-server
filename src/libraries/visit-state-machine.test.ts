import { test } from "node:test";
import assert from "node:assert/strict";
import { VISIT_STATUS, type VisitStatus } from "../constants/visit-status";
import { InvalidTransitionError } from "../constants/errors";
import {
  ALLOWED_VISIT_TRANSITIONS,
  OPEN_VISIT_STATUSES,
  assertVisitTransition,
} from "./visit-state-machine";

const { SCHEDULED, EN_ROUTE, IN_PROGRESS, DONE, CANCELLED } = VISIT_STATUS;

const LEGAL_EDGES: Array<[VisitStatus, VisitStatus]> = [
  [SCHEDULED, EN_ROUTE],
  [SCHEDULED, IN_PROGRESS],
  [SCHEDULED, CANCELLED],
  [EN_ROUTE, IN_PROGRESS],
  [EN_ROUTE, CANCELLED],
  [IN_PROGRESS, DONE],
  [IN_PROGRESS, CANCELLED],
];

for (const [from, to] of LEGAL_EDGES) {
  test(`visit ${from} -> ${to} is allowed`, () => {
    assert.doesNotThrow(() => assertVisitTransition(from, to));
  });
}

const isLegal = (from: VisitStatus, to: VisitStatus) =>
  LEGAL_EDGES.some(([f, t]) => f === from && t === to);

for (const from of Object.values(VISIT_STATUS)) {
  for (const to of Object.values(VISIT_STATUS)) {
    if (isLegal(from, to)) continue;
    test(`visit ${from} -> ${to} throws InvalidTransitionError`, () => {
      try {
        assertVisitTransition(from, to);
        assert.fail("expected assertVisitTransition to throw");
      } catch (err) {
        assert.ok(err instanceof InvalidTransitionError);
        assert.equal(err.code, "INVALID_TRANSITION");
      }
    });
  }
}

test("ALLOWED_VISIT_TRANSITIONS encodes exactly the legal edges", () => {
  const encoded = Object.values(VISIT_STATUS).flatMap((from) =>
    ALLOWED_VISIT_TRANSITIONS[from].map((to) => `${from}->${to}`)
  );
  assert.deepEqual(
    [...encoded].sort(),
    LEGAL_EDGES.map(([from, to]) => `${from}->${to}`).sort()
  );
});

test("open visit statuses are exactly scheduled, en_route and in_progress", () => {
  assert.deepEqual(
    [...OPEN_VISIT_STATUSES].sort(),
    [SCHEDULED, EN_ROUTE, IN_PROGRESS].sort()
  );
});

test("every open visit status can be cancelled, so a bulk cancel is always legal", () => {
  for (const status of OPEN_VISIT_STATUSES) {
    assert.doesNotThrow(() => assertVisitTransition(status, CANCELLED));
  }
});

test("done and cancelled visits are final", () => {
  assert.deepEqual(ALLOWED_VISIT_TRANSITIONS[DONE], []);
  assert.deepEqual(ALLOWED_VISIT_TRANSITIONS[CANCELLED], []);
});
