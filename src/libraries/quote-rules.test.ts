import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError } from "../constants/errors";
import { assertQuoteMove } from "./quote-rules";

interface Case {
  from: PriceStatus;
  to: PriceStatus;
  during: RequestStatus;
}

const ALLOWED_CASES: Case[] = [
  {
    from: PRICE_STATUS.NONE,
    to: PRICE_STATUS.PROPOSED,
    during: REQUEST_STATUS.PENDING,
  },
  {
    from: PRICE_STATUS.DECLINED,
    to: PRICE_STATUS.PROPOSED,
    during: REQUEST_STATUS.PENDING,
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.ACCEPTED,
    during: REQUEST_STATUS.PENDING,
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.DECLINED,
    during: REQUEST_STATUS.PENDING,
  },
  {
    from: PRICE_STATUS.ACCEPTED,
    to: PRICE_STATUS.PROPOSED,
    during: REQUEST_STATUS.IN_PROGRESS,
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.ACCEPTED,
    during: REQUEST_STATUS.IN_PROGRESS,
  },
];

for (const { from, to, during } of ALLOWED_CASES) {
  test(`quote ${from} -> ${to} while ${during} is allowed`, () => {
    assert.doesNotThrow(() => assertQuoteMove(from, to, during));
  });
}

function assertRefused(
  from: PriceStatus,
  to: PriceStatus,
  during: RequestStatus,
  wrongStatus: boolean
): void {
  try {
    assertQuoteMove(from, to, during);
    assert.fail("expected assertQuoteMove to throw");
  } catch (err) {
    assert.ok(err instanceof InvalidTransitionError);
    assert.equal(err.code, "INVALID_TRANSITION");
    assert.equal(err.message.includes("while the request is"), wrongStatus);
  }
}

// Moves no rule allows, whatever the request status.
const WRONG_PRICE_STATUS_MOVES: Array<{ from: PriceStatus; to: PriceStatus }> =
  [
    { from: PRICE_STATUS.NONE, to: PRICE_STATUS.ACCEPTED },
    { from: PRICE_STATUS.NONE, to: PRICE_STATUS.DECLINED },
    { from: PRICE_STATUS.DECLINED, to: PRICE_STATUS.ACCEPTED },
    { from: PRICE_STATUS.DECLINED, to: PRICE_STATUS.DECLINED },
    { from: PRICE_STATUS.ACCEPTED, to: PRICE_STATUS.ACCEPTED },
    { from: PRICE_STATUS.ACCEPTED, to: PRICE_STATUS.DECLINED },
    { from: PRICE_STATUS.PROPOSED, to: PRICE_STATUS.PROPOSED },
    { from: PRICE_STATUS.ACCEPTED, to: PRICE_STATUS.NONE },
  ];

for (const { from, to } of WRONG_PRICE_STATUS_MOVES) {
  for (const during of Object.values(REQUEST_STATUS)) {
    test(`quote ${from} -> ${to} while ${during} is refused`, () => {
      assertRefused(from, to, during, false);
    });
  }
}

// Each allowed move, during every request status not listed for it above:
// e.g. accepting a quote on a cancelled, rejected or completed job.
const ALLOWED_MOVES = new Map(
  ALLOWED_CASES.map(({ from, to }) => [`${from}->${to}`, { from, to }])
);

for (const { from, to } of ALLOWED_MOVES.values()) {
  for (const during of Object.values(REQUEST_STATUS)) {
    const allowed = ALLOWED_CASES.some(
      (c) => c.from === from && c.to === to && c.during === during
    );
    if (allowed) continue;
    test(`quote ${from} -> ${to} while ${during} is refused`, () => {
      assertRefused(from, to, during, true);
    });
  }
}
