export const REQUEST_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const;

export type RequestStatus =
  (typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS];

export const ALLOWED_TRANSITIONS: Record<
  RequestStatus,
  readonly RequestStatus[]
> = {
  pending: ["accepted", "rejected", "cancelled"],
  accepted: ["completed", "cancelled"],
  rejected: [],
  cancelled: [],
  completed: [],
} as const;
