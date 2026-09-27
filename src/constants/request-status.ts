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

export const REQUEST_ACTOR_ROLE = {
  CUSTOMER: "customer",
  PROVIDER: "provider",
} as const;

export type RequestActorRole =
  (typeof REQUEST_ACTOR_ROLE)[keyof typeof REQUEST_ACTOR_ROLE];
