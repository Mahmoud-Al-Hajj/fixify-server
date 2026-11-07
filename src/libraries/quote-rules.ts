import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError } from "../constants/errors";

// Legal quote moves, and while the request is in which status. Pending moves are the initial quote. In-progress moves are a revised
// quote for extra work found mid-job; declining a revision keeps the agreed
// price, so it also lands on accepted.
export const QUOTE_RULES: ReadonlyArray<{
  from: PriceStatus;
  to: PriceStatus;
  during: readonly RequestStatus[];
}> = [
  {
    from: PRICE_STATUS.NONE,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.DECLINED,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.ACCEPTED,
    during: [REQUEST_STATUS.PENDING, REQUEST_STATUS.IN_PROGRESS],
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.DECLINED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.ACCEPTED,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.IN_PROGRESS],
  },
];

export function assertQuoteMove(
  fromPriceStatus: PriceStatus,
  toPriceStatus: PriceStatus,
  requestStatus: RequestStatus
): void {
  const move = `quote from '${fromPriceStatus}' to '${toPriceStatus}'`;
  const rule = QUOTE_RULES.find(
    (r) => r.from === fromPriceStatus && r.to === toPriceStatus
  );
  if (!rule) {
    throw new InvalidTransitionError(`Cannot move ${move}`);
  }
  if (!rule.during.includes(requestStatus)) {
    throw new InvalidTransitionError(
      `Cannot move ${move} while the request is '${requestStatus}'`
    );
  }
}
