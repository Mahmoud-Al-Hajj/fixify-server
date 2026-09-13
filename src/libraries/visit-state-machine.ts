import { VISIT_STATUS, type VisitStatus } from "../constants/visit-status";
import { InvalidTransitionError } from "../constants/errors";

// Edges only, no actors: in this phase a visit only moves as a consequence of
// a request action (start, complete, cancel), and that action has already
// checked the actor against TRANSITION_ACTORS. Starting goes straight from
// scheduled to in_progress; en_route ("On my way") is a Phase 4 addition that
// will be layered on top later — no action moves a visit into it yet.
export const ALLOWED_VISIT_TRANSITIONS: Record<
  VisitStatus,
  readonly VisitStatus[]
> = {
  [VISIT_STATUS.SCHEDULED]: [
    VISIT_STATUS.EN_ROUTE,
    VISIT_STATUS.IN_PROGRESS,
    VISIT_STATUS.CANCELLED,
  ],
  [VISIT_STATUS.EN_ROUTE]: [VISIT_STATUS.IN_PROGRESS, VISIT_STATUS.CANCELLED],
  [VISIT_STATUS.IN_PROGRESS]: [VISIT_STATUS.DONE, VISIT_STATUS.CANCELLED],
  [VISIT_STATUS.DONE]: [],
  [VISIT_STATUS.CANCELLED]: [],
};

// Visits that still hold a slot and can still move. Cancelling a request
// cancels all of these; done visits stay as history.
export const OPEN_VISIT_STATUSES: readonly VisitStatus[] = Object.values(
  VISIT_STATUS
).filter((status) => ALLOWED_VISIT_TRANSITIONS[status].length > 0);

export function assertVisitTransition(
  currentStatus: VisitStatus,
  targetStatus: VisitStatus
): void {
  if (!ALLOWED_VISIT_TRANSITIONS[currentStatus].includes(targetStatus)) {
    throw new InvalidTransitionError(
      `Cannot transition visit from '${currentStatus}' to '${targetStatus}'`
    );
  }
}
