import {
  REQUEST_STATUS,
  REQUEST_ACTOR_ROLE,
  type RequestStatus,
  type RequestActorRole,
} from "../constants/request-status";
import { InvalidTransitionError, ForbiddenError } from "../constants/errors";

// The request lifecycle: each legal (current -> target) transition and the
// role(s) allowed to perform it; a pair missing here is illegal. Quoting never
// touches status, so pending -> scheduled is the CUSTOMER accepting a quote,
// not a provider "accept" action.
export const TRANSITION_ACTORS: Record<
  RequestStatus,
  Partial<Record<RequestStatus, readonly RequestActorRole[]>>
> = {
  [REQUEST_STATUS.PENDING]: {
    [REQUEST_STATUS.SCHEDULED]: [REQUEST_ACTOR_ROLE.CUSTOMER],
    [REQUEST_STATUS.REJECTED]: [REQUEST_ACTOR_ROLE.PROVIDER],
    [REQUEST_STATUS.CANCELLED]: [REQUEST_ACTOR_ROLE.CUSTOMER],
  },
  [REQUEST_STATUS.SCHEDULED]: {
    [REQUEST_STATUS.IN_PROGRESS]: [REQUEST_ACTOR_ROLE.PROVIDER],
    [REQUEST_STATUS.CANCELLED]: [
      REQUEST_ACTOR_ROLE.CUSTOMER,
      REQUEST_ACTOR_ROLE.PROVIDER,
    ],
  },
  [REQUEST_STATUS.IN_PROGRESS]: {
    [REQUEST_STATUS.COMPLETED]: [REQUEST_ACTOR_ROLE.PROVIDER],
    [REQUEST_STATUS.CANCELLED]: [
      REQUEST_ACTOR_ROLE.CUSTOMER,
      REQUEST_ACTOR_ROLE.PROVIDER,
    ],
  },
  [REQUEST_STATUS.COMPLETED]: {},
  [REQUEST_STATUS.REJECTED]: {},
  [REQUEST_STATUS.CANCELLED]: {},
};

export function assertRequestTransition(
  currentStatus: RequestStatus,
  targetStatus: RequestStatus,
  actorRole: RequestActorRole
): void {
  const allowedActors = TRANSITION_ACTORS[currentStatus][targetStatus];
  if (!allowedActors) {
    throw new InvalidTransitionError(
      `Cannot transition request from '${currentStatus}' to '${targetStatus}'`
    );
  }
  if (!allowedActors.includes(actorRole)) {
    throw new ForbiddenError(
      `A ${actorRole} may not transition a request from '${currentStatus}' to '${targetStatus}'`
    );
  }
}
