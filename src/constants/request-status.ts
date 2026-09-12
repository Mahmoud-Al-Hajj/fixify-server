export const REQUEST_STATUS = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const;

export type RequestStatus =
  (typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS];

// pending -> scheduled fires when the CUSTOMER ACCEPTS THE QUOTE, not when
// a provider "accepts" the request — there is no such action. Quoting only
// moves price_status (none -> proposed); accepting it sets price_status to
// accepted AND status to scheduled, in one transaction, and creates the
// first visit.
export const ALLOWED_TRANSITIONS: Record<
  RequestStatus,
  readonly RequestStatus[]
> = {
  pending: ["scheduled", "rejected", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  rejected: [],
  cancelled: [],
} as const;
