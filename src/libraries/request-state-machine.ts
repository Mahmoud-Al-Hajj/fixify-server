import {
  REQUEST_STATUS,
  ALLOWED_TRANSITIONS,
  type RequestStatus,
} from "../constants/request-status";
import { InvalidTransitionError, ForbiddenError } from "../constants/errors";

export const REQUEST_ACTOR_ROLE = {
  CUSTOMER: "customer",
  PROVIDER: "provider",
} as const;

export type RequestActorRole =
  (typeof REQUEST_ACTOR_ROLE)[keyof typeof REQUEST_ACTOR_ROLE];

// Which role(s) may perform each specific (current -> target) transition.
// Derived from the lifecycle diagram: quoting never touches status, so
// pending -> scheduled is the CUSTOMER accepting a quote, not a provider
// "accept" action. Kept separate from ALLOWED_TRANSITIONS (legality) —
// see the consistency test in request-state-machine.test.ts, which keeps
// the two tables from drifting apart.
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
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(targetStatus)) {
    throw new InvalidTransitionError(
      `Cannot transition request from '${currentStatus}' to '${targetStatus}'`
    );
  }

  const allowedActors = TRANSITION_ACTORS[currentStatus][targetStatus];
  if (!allowedActors?.includes(actorRole)) {
    throw new ForbiddenError(
      `A ${actorRole} may not transition a request from '${currentStatus}' to '${targetStatus}'`
    );
  }
}
