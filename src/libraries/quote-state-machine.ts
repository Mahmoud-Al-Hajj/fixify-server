import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError, ForbiddenError } from "../constants/errors";
import {
  REQUEST_ACTOR_ROLE,
  type RequestActorRole,
} from "../constants/request-status";

interface QuoteTransitionRule {
  actor: RequestActorRole;
  requestStatuses: readonly RequestStatus[];
}

// Quote state lives in requests.price_status and moves independently of the
// job status, but which quote moves are legal still depends on where the job
// is: an initial quote happens while pending, a revision while in progress.
// Like request status, price_status has no active CHECK constraint, so this
// table is the only thing keeping it valid.
export const QUOTE_TRANSITIONS: Record<
  PriceStatus,
  Partial<Record<PriceStatus, QuoteTransitionRule>>
> = {
  [PRICE_STATUS.NONE]: {
    [PRICE_STATUS.PROPOSED]: {
      actor: REQUEST_ACTOR_ROLE.PROVIDER,
      requestStatuses: [REQUEST_STATUS.PENDING],
    },
  },
  [PRICE_STATUS.PROPOSED]: {
    [PRICE_STATUS.ACCEPTED]: {
      actor: REQUEST_ACTOR_ROLE.CUSTOMER,
      requestStatuses: [REQUEST_STATUS.PENDING, REQUEST_STATUS.IN_PROGRESS],
    },
    [PRICE_STATUS.DECLINED]: {
      actor: REQUEST_ACTOR_ROLE.CUSTOMER,
      requestStatuses: [REQUEST_STATUS.PENDING, REQUEST_STATUS.IN_PROGRESS],
    },
  },
  [PRICE_STATUS.ACCEPTED]: {
    // The revision path: additional work discovered mid-job.
    [PRICE_STATUS.PROPOSED]: {
      actor: REQUEST_ACTOR_ROLE.PROVIDER,
      requestStatuses: [REQUEST_STATUS.IN_PROGRESS],
    },
  },
  [PRICE_STATUS.DECLINED]: {
    [PRICE_STATUS.PROPOSED]: {
      actor: REQUEST_ACTOR_ROLE.PROVIDER,
      requestStatuses: [REQUEST_STATUS.PENDING, REQUEST_STATUS.IN_PROGRESS],
    },
  },
};

export function assertQuoteTransition(
  currentPriceStatus: PriceStatus,
  targetPriceStatus: PriceStatus,
  actorRole: RequestActorRole,
  requestStatus: RequestStatus
): void {
  const rule = QUOTE_TRANSITIONS[currentPriceStatus][targetPriceStatus];
  if (!rule) {
    throw new InvalidTransitionError(
      `Cannot move quote from '${currentPriceStatus}' to '${targetPriceStatus}'`
    );
  }
  if (rule.actor !== actorRole) {
    throw new ForbiddenError(
      `A ${actorRole} may not move a quote from '${currentPriceStatus}' to '${targetPriceStatus}'`
    );
  }
  if (!rule.requestStatuses.includes(requestStatus)) {
    throw new InvalidTransitionError(
      `Cannot move quote from '${currentPriceStatus}' to '${targetPriceStatus}' while the request is '${requestStatus}'`
    );
  }
}
