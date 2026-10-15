import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { VISIT_STATUS, type VisitStatus } from "../constants/visit-status";
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  ValidationError,
} from "../constants/errors";

export const RESCHEDULE_ACTION = {
  PROPOSE: "propose",
  ACCEPT: "accept",
  DECLINE: "decline",
  WITHDRAW: "withdraw",
} as const;

export type RescheduleAction =
  (typeof RESCHEDULE_ACTION)[keyof typeof RESCHEDULE_ACTION];

// A visit can be moved while the job is still to happen or under way.
const RESCHEDULABLE_DURING: readonly RequestStatus[] = [
  REQUEST_STATUS.SCHEDULED,
  REQUEST_STATUS.IN_PROGRESS,
];

export interface RescheduleCheck {
  action: RescheduleAction;
  requestStatus: RequestStatus;
  visitStatus: VisitStatus;
  // The open proposal, if any: its start and the user who made it.
  proposal: { start: Date; by: string } | null;
  actorUserId: string;
  now: Date;
  // The time being proposed; propose only.
  newStart: Date | null;
}

// Who may take a reschedule action, and when. Either party proposes; the
// other accepts or declines; the proposer withdraws. One open proposal per
// visit. A proposal whose time has passed can no longer be accepted, but can
// still be declined or withdrawn. Working hours are checked by the caller.
export function assertRescheduleAction(check: RescheduleCheck): void {
  if (!RESCHEDULABLE_DURING.includes(check.requestStatus)) {
    throw new InvalidTransitionError(
      `A visit cannot be rescheduled while the request is '${check.requestStatus}'`
    );
  }
  if (check.visitStatus !== VISIT_STATUS.SCHEDULED) {
    throw new InvalidTransitionError(
      `Only a scheduled visit can be rescheduled; this one is '${check.visitStatus}'`
    );
  }
  const { proposal } = check;
  if (check.action === RESCHEDULE_ACTION.PROPOSE) {
    if (proposal !== null) {
      throw new ConflictError(
        "A new time is already proposed for this visit; it must be answered or withdrawn first"
      );
    }
    if (check.newStart === null || check.newStart <= check.now) {
      throw new ValidationError("The proposed start must be in the future");
    }
    return;
  }
  if (proposal === null) {
    throw new ConflictError("No new time is proposed for this visit");
  }
  const isProposer = proposal.by === check.actorUserId;
  if (check.action === RESCHEDULE_ACTION.WITHDRAW) {
    if (!isProposer) {
      throw new ForbiddenError(
        "Only whoever proposed the new time can withdraw it"
      );
    }
    return;
  }
  if (isProposer) {
    throw new ForbiddenError(
      "You proposed this time; the other party accepts or declines it"
    );
  }
  if (
    check.action === RESCHEDULE_ACTION.ACCEPT &&
    proposal.start <= check.now
  ) {
    throw new ConflictError(
      "The proposed time has passed; decline it or propose a new one"
    );
  }
}
